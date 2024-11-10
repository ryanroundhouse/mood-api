import sqlite3
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
import requests
import uuid

# Load environment variables
load_dotenv()

# Add email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")
RECIPIENT_EMAIL = "ryan@moodful.ca"

# Database configuration
DB_PATH = "../database.sqlite"

def get_date_ranges():
    """Get the date ranges for past week, previous week, and previous month"""
    now = datetime.now()
    
    # Past week
    week_end = now
    week_start = now - timedelta(days=7)
    
    # Previous week
    prev_week_end = week_start
    prev_week_start = prev_week_end - timedelta(days=7)
    
    # Previous month
    month_end = now
    month_start = now - timedelta(days=30)
    
    return {
        'past_week': (week_start, week_end),
        'prev_week': (prev_week_start, prev_week_end),
        'past_month': (month_start, month_end)
    }

def get_user_counts():
    """Get counts of users by account level"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT 
            accountLevel,
            COUNT(*) as count
        FROM users
        WHERE isVerified = 1
        GROUP BY accountLevel
    """)
    
    results = cursor.fetchall()
    conn.close()
    
    user_counts = {
        'basic': 0,
        'pro': 0,
        'enterprise': 0
    }
    
    for level, count in results:
        if level in user_counts:
            user_counts[level] = count
    
    return user_counts

def get_active_users(start_date, end_date):
    """Get count of users who submitted moods within date range"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT COUNT(DISTINCT userId) 
        FROM moods 
        WHERE datetime >= ? AND datetime < ?
    """, (start_date.isoformat(), end_date.isoformat()))
    
    count = cursor.fetchone()[0]
    conn.close()
    
    return count

def get_mood_submission_stats():
    """Get mood submission statistics for different time periods"""
    date_ranges = get_date_ranges()
    
    stats = {
        'past_week_users': get_active_users(
            date_ranges['past_week'][0],
            date_ranges['past_week'][1]
        ),
        'prev_week_users': get_active_users(
            date_ranges['prev_week'][0],
            date_ranges['prev_week'][1]
        ),
        'past_month_users': get_active_users(
            date_ranges['past_month'][0],
            date_ranges['past_month'][1]
        )
    }
    
    return stats

def get_engagement_rate(active_users, total_users):
    """Calculate engagement rate as percentage"""
    if total_users == 0:
        return 0
    return (active_users / total_users) * 100

def get_weekly_user_type_stats():
    """Get weekly active users broken down by account type"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Start from September 29th
    start_date = datetime(2024, 9, 29)
    weeks = []
    current_date = datetime.now()
    
    # Generate list of week ranges
    current = start_date
    while current < current_date:
        week_end = current + timedelta(days=7)
        weeks.append((current, week_end))
        current = week_end
    
    # Query for each week
    results = []
    for start, end in weeks:
        # Initialize all values to 0 first
        week_data = {
            'week_start': start,
            'basic': 0,
            'pro': 0,
            'new_users': 0,
            'churned_users': 0,
            'power_users': 0
        }
        
        # Get active users by type
        cursor.execute("""
            SELECT u.accountLevel, COUNT(DISTINCT m.userId)
            FROM users u
            LEFT JOIN moods m ON u.id = m.userId 
            AND m.datetime >= ? AND m.datetime < ?
            WHERE u.isVerified = 1
            AND u.accountLevel IN ('basic', 'pro')
            GROUP BY u.accountLevel
        """, (start.isoformat(), end.isoformat()))
        
        for level, count in cursor.fetchall():
            if level in week_data:
                week_data[level] = count or 0  # Convert None to 0
            
        # Get power users (5+ moods in the week)
        cursor.execute("""
            SELECT COUNT(DISTINCT userId)
            FROM (
                SELECT userId
                FROM moods
                WHERE datetime >= ? AND datetime < ?
                GROUP BY userId
                HAVING COUNT(*) >= 5
            )
        """, (start.isoformat(), end.isoformat()))
        
        result = cursor.fetchone()
        week_data['power_users'] = result[0] if result else 0
        
        # Get new users
        cursor.execute("""
            SELECT COUNT(DISTINCT userId)
            FROM (
                SELECT userId, MIN(datetime) as first_mood
                FROM moods
                GROUP BY userId
                HAVING first_mood >= ? AND first_mood < ?
            )
        """, (start.isoformat(), end.isoformat()))
        
        result = cursor.fetchone()
        week_data['new_users'] = result[0] if result else 0
        
        # Get churned users
        cursor.execute("""
            SELECT COUNT(DISTINCT userId)
            FROM (
                SELECT userId, MAX(datetime) as last_mood
                FROM moods
                GROUP BY userId
                HAVING last_mood >= ? AND last_mood < ?
            )
        """, (start.isoformat(), end.isoformat()))
        
        result = cursor.fetchone()
        week_data['churned_users'] = result[0] if result else 0
        
        results.append(week_data)
    
    conn.close()
    return results

def send_stats_email(stats_content):
    """Send statistics email using Mailgun"""
    try:
        message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
        current_date = datetime.now().strftime("%Y-%m-%d")
        
        # Create the HTML email content without double-converting the table
        html_content = f"""
        <html>
        <head>
            <style>
                body {{
                    font-family: monospace;
                    max-width: 1000px;
                    margin: 0 auto;
                    padding: 20px;
                }}
                table {{
                    border-collapse: collapse;
                    width: 100%;
                    margin: 20px 0;
                }}
                th, td {{
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }}
                th {{
                    background-color: #f2f2f2;
                }}
            </style>
        </head>
        <body>
            {stats_content}
        </body>
        </html>
        """
        
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": f"Weekly Moodful Stats <{SENDER_EMAIL}>",
                "to": [RECIPIENT_EMAIL],
                "subject": f"Moodful Usage Statistics Report - {current_date}",
                "html": html_content,
                "h:Message-ID": message_id,
            }
        )
        response.raise_for_status()
        print("Statistics email sent successfully")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send statistics email. Error: {str(e)}")

def main():
    # Capture the output
    import io
    from contextlib import redirect_stdout
    
    f = io.StringIO()
    with redirect_stdout(f):
        # Get user counts by account level
        user_counts = get_user_counts()
        total_users = sum(user_counts.values())
        
        # Get mood submission stats
        submission_stats = get_mood_submission_stats()
        
        # Calculate engagement rates
        week_engagement = get_engagement_rate(
            submission_stats['past_week_users'],
            total_users
        )
        month_engagement = get_engagement_rate(
            submission_stats['past_month_users'],
            total_users
        )
        
        # Print the statistics
        print("=== Moodful Usage Statistics ===<br/><br/>")
        
        print("User Counts:<br/>")
        print(f"Basic Users: {user_counts['basic']}<br/>")
        print(f"Pro Users: {user_counts['pro']}<br/>")
        print(f"Enterprise Users: {user_counts['enterprise']}<br/>")
        print(f"Total Users: {total_users}<br/><br/>")
        
        print("Active Users:<br/>")
        print(f"Past Week: {submission_stats['past_week_users']}<br/>")
        print(f"Previous Week: {submission_stats['prev_week_users']}<br/>")
        print(f"Past Month: {submission_stats['past_month_users']}<br/><br/>")
        
        print("Engagement Rates:<br/>")
        print(f"Weekly Engagement: {week_engagement:.1f}%<br/>")
        print(f"Monthly Engagement: {month_engagement:.1f}%<br/>")
        
        # Calculate week-over-week change
        wow_change = (
            (submission_stats['past_week_users'] - submission_stats['prev_week_users'])
            / submission_stats['prev_week_users'] * 100
            if submission_stats['prev_week_users'] > 0
            else 0
        )
        print(f"Week-over-Week Change: {wow_change:+.1f}%<br/><br/>")
        
        # Replace the weekly breakdown table with HTML version
        print("Weekly Active Users by Account Type:")
        weekly_stats = get_weekly_user_type_stats()
        
        print("""
<table>
    <thead>
        <tr>
            <th>Week of</th>
            <th>Basic</th>
            <th>Pro</th>
            <th>New Users</th>
            <th>Churned</th>
            <th>Net Change</th>
            <th>Power Users</th>
        </tr>
    </thead>
    <tbody>""")
        
        # Print each week's data
        for week in weekly_stats:
            date_str = week['week_start'].strftime("%Y-%m-%d")
            net_change = week['new_users'] - week['churned_users']
            print(f"""        <tr><td>{date_str}</td><td>{week['basic']}</td><td>{week['pro']}</td><td>{week['new_users']}</td><td>{week['churned_users']}</td><td>{net_change}</td><td>{week['power_users']}</td></tr>""", end='')
        
        print("""    </tbody>
</table>
""")
    
    # Get the captured output and send via email
    stats_content = f.getvalue()
    send_stats_email(stats_content)

if __name__ == "__main__":
    main()