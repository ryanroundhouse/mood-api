import sqlite3
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import calendar
from datetime import datetime, timedelta
from dotenv import load_dotenv
import json

# Load environment variables
load_dotenv()

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")

# Database configuration
DB_PATH = "../database.sqlite"

def get_users():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT users.id, users.email 
        FROM users 
        JOIN notifications ON users.id = notifications.userId 
        WHERE users.isVerified = 1 AND notifications.weeklySummary = 1
    """)
    users = cursor.fetchall()
    conn.close()
    return users

def get_user_moods(user_id, year, month):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    start_date = datetime(year, month, 1)
    end_date = start_date + timedelta(days=32)
    end_date = end_date.replace(day=1)
    
    cursor.execute("""
        SELECT strftime('%d', datetime) as day, rating, comment, activities
        FROM moods
        WHERE userId = ? AND datetime >= ? AND datetime < ?
    """, (user_id, start_date.isoformat(), end_date.isoformat()))
    
    moods = {row[0]: {'rating': row[1], 'comment': row[2], 'activities': json.loads(row[3]) if row[3] else []} for row in cursor.fetchall()}
    conn.close()
    return moods

def generate_calendar_html(year, month, moods):
    cal = calendar.monthcalendar(year, month)
    month_name = calendar.month_name[month]
    
    html = f"""
    <h2>{month_name} {year}</h2>
    <table style="border-collapse: collapse; width: 100%;">
        <tr>
            <th style="border: 1px solid #ddd; padding: 8px;">Sun</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Mon</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Tue</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Wed</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Thu</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Fri</th>
            <th style="border: 1px solid #ddd; padding: 8px;">Sat</th>
        </tr>
    """
    
    mood_colors = ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff']
    
    for week in cal:
        html += "<tr>"
        for day in week:
            if day == 0:
                html += '<td style="border: 1px solid #ddd; padding: 8px;"></td>'
            else:
                mood = moods.get(f"{day:02d}")
                if mood:
                    bg_color = mood_colors[mood['rating']]
                    activities = ", ".join(mood['activities']) if mood['activities'] else 'No activities'
                    title = f"Mood: {mood['rating']}, Comment: {mood['comment'] or 'No comment'}, Activities: {activities}"
                else:
                    bg_color = 'white'
                    title = ''
                
                html += f'<td style="border: 1px solid #ddd; padding: 8px; background-color: {bg_color};" title="{title}">{day}</td>'
        html += "</tr>"
    
    html += "</table>"
    
    # Add legend
    html += """
    <div style="margin-top: 20px;">
        <h3>Mood Legend</h3>
        <div style="display: flex; justify-content: space-between;">
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffb3ba; margin-right: 5px;"></span>Very Sad</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffdfba; margin-right: 5px;"></span>Sad</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffffba; margin-right: 5px;"></span>Neutral</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #baffc9; margin-right: 5px;"></span>Happy</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #bae1ff; margin-right: 5px;"></span>Very Happy</div>
        </div>
    </div>
    """
    
    return html

def send_email(to_email, calendar_html):
    subject = "Your Monthly Mood Calendar"
    
    html_content = f"""
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Monthly Mood Calendar - MoodTracker</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #6a89cc;">Your Monthly Mood Calendar</h1>
        <p>Here's a summary of your mood entries for this month:</p>
        {calendar_html}
        <p>Keep tracking your moods and stay mindful of your emotional well-being!</p>
    </body>
    </html>
    """

    try:
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": f"MoodTracker <{SENDER_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content
            }
        )
        response.raise_for_status()
        print(f"Email sent successfully to {to_email}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send email to {to_email}. Error: {str(e)}")

def main():
    users = get_users()
    current_date = datetime.now()
    year, month = current_date.year, current_date.month
    
    for user_id, email in users:
        moods = get_user_moods(user_id, year, month)
        calendar_html = generate_calendar_html(year, month, moods)
        send_email(email, calendar_html)

if __name__ == "__main__":
    main()