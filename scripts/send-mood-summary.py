import sqlite3
import requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import calendar
from datetime import datetime, timedelta
from dotenv import load_dotenv
import json
from collections import defaultdict, Counter
import re
import random
import nltk
import pathlib
import logging
nltk.download('opinion_lexicon')
nltk.download('wordnet')
from nltk.corpus import opinion_lexicon
from nltk.corpus import wordnet
from openai import OpenAI
from Crypto.Cipher import AES

# Load environment variables from project root .env file
script_dir = pathlib.Path(__file__).parent.absolute()
project_root = script_dir.parent
dotenv_path = project_root / '.env'
load_dotenv(dotenv_path=dotenv_path)

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")
BASE_URL = os.getenv("MOOD_SITE_URL", "http://localhost:3000")

# Database configuration
DB_PATH = os.path.join(project_root, "database.sqlite")

# OpenAI configuration
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY)

def get_or_create_unsubscribe_token(user_id):
    """Gets or creates an unsubscribe token for the user."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT unsubscribeToken FROM user_settings WHERE userId = ?", (user_id,))
    row = cursor.fetchone()
    if row and row[0]:
        token = row[0]
    else:
        token = os.urandom(16).hex()
        cursor.execute("UPDATE user_settings SET unsubscribeToken = ? WHERE userId = ?", (token, user_id))
        conn.commit()
    conn.close()
    return token

def get_users():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT users.id, users.email, user_settings.emailWeeklySummary, user_settings.ai_insights
        FROM users 
        JOIN user_settings ON users.id = user_settings.userId 
        WHERE users.isVerified = 1
    """)
    users = cursor.fetchall()
    conn.close()
    return users

from datetime import datetime, timedelta, timezone

import re
from datetime import datetime, timedelta

def decrypt(encrypted_data):
    if not encrypted_data:
        return None
    
    try:
        # Split the encrypted data into its components
        iv_hex, tag_hex, ciphertext_hex = encrypted_data.split(':')
        
        # Convert hex strings back to bytes
        iv = bytes.fromhex(iv_hex)
        tag = bytes.fromhex(tag_hex)
        ciphertext = bytes.fromhex(ciphertext_hex)
        
        # Create cipher object
        cipher = AES.new(bytes.fromhex(os.getenv('ENCRYPTION_KEY')), AES.MODE_GCM, nonce=iv)
        
        # Decrypt the data
        decrypted = cipher.decrypt_and_verify(ciphertext, tag)
        
        return decrypted.decode()
    except Exception as e:
        print(f"Error decrypting data: {e}")
        return None

def get_user_moods(user_id, start_date, end_date):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        SELECT datetime, rating, comment, activities
        FROM moods
        WHERE userId = ? AND datetime >= ? AND datetime < ?
    """, (user_id, start_date.isoformat(), end_date.isoformat()))
    
    moods = {}
    for row in cursor.fetchall():
        # Strip off timezone information
        dt_str = re.sub(r'(Z|[+-]\d{2}:\d{2})$', '', row[0])
        dt = datetime.fromisoformat(dt_str)
        day_key = dt.strftime('%Y-%m-%d')  # Use full date as key instead of just day
        # Decrypt the comment
        decrypted_comment = decrypt(row[2]) if row[2] else None
        moods[day_key] = {
            'date': dt.strftime('%Y-%m-%d'),
            'rating': row[1], 
            'comment': decrypted_comment, 
            'activities': json.loads(row[3]) if row[3] else []
        }
    
    # Fetch sleep data for the same date range
    cursor.execute("""
        SELECT calendarDate, durationInHours, deepSleepDurationInHours, 
               lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
               startTimeInSeconds, startTimeOffsetInSeconds
        FROM sleep_summaries
        WHERE userId = ? AND calendarDate >= ? AND calendarDate <= ?
    """, (user_id, start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')))
    
    # Merge sleep data into mood entries
    for sleep_row in cursor.fetchall():
        calendar_date = sleep_row[0]  # calendarDate is already in YYYY-MM-DD format
        sleep_data = {
            'total_sleep_hours': sleep_row[1] if sleep_row[1] else 0,
            'deep_sleep_hours': sleep_row[2] if sleep_row[2] else 0,
            'light_sleep_hours': sleep_row[3] if sleep_row[3] else 0,
            'rem_sleep_hours': sleep_row[4] if sleep_row[4] else 0,
            'awake_hours': sleep_row[5] if sleep_row[5] else 0,
            'start_time_seconds': sleep_row[6] if sleep_row[6] else None,
            'start_time_offset_seconds': sleep_row[7] if sleep_row[7] else None
        }
        
        # If mood entry exists for this date, add sleep data to it
        if calendar_date in moods:
            moods[calendar_date]['sleep_data'] = sleep_data
        else:
            # Create a mood entry with just sleep data (no mood rating)
            moods[calendar_date] = {
                'date': calendar_date,
                'rating': None,
                'comment': None,
                'activities': [],
                'sleep_data': sleep_data
            }
    
    # Fetch daily summary data for the same date range
    cursor.execute("""
        SELECT calendarDate, steps, distanceInMeters, activeTimeInHours, 
               floorsClimbed, averageStressLevel, maxStressLevel, stressDurationInMinutes
        FROM daily_summaries
        WHERE userId = ? AND calendarDate >= ? AND calendarDate <= ?
    """, (user_id, start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')))
    
    # Merge daily summary data into mood entries
    for daily_row in cursor.fetchall():
        calendar_date = daily_row[0]  # calendarDate is already in YYYY-MM-DD format
        daily_data = {
            'steps': daily_row[1] if daily_row[1] else 0,
            'distance_meters': daily_row[2] if daily_row[2] else 0,
            'active_time_hours': daily_row[3] if daily_row[3] else 0,
            'floors_climbed': daily_row[4] if daily_row[4] else 0,
            'average_stress_level': daily_row[5] if daily_row[5] else None,
            'max_stress_level': daily_row[6] if daily_row[6] else None,
            'stress_duration_minutes': daily_row[7] if daily_row[7] else 0
        }
        
        # If mood entry exists for this date, add daily data to it
        if calendar_date in moods:
            moods[calendar_date]['daily_data'] = daily_data
        else:
            # Create a mood entry with just daily data (no mood rating)
            moods[calendar_date] = {
                'date': calendar_date,
                'rating': None,
                'comment': None,
                'activities': [],
                'daily_data': daily_data
            }
    
    conn.close()
    return moods

def generate_calendar_html(start_date, end_date, moods):
    # Generate a calendar view for the last 30 days
    html = f"""
    <h2>Last 30 Days ({start_date.strftime('%B %d, %Y')} - {end_date.strftime('%B %d, %Y')})</h2>
    <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <tr>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Sun</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Mon</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Tue</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Wed</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Thu</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Fri</th>
            <th style="border: 1px solid #ddd; padding: 8px; background-color: #f5f5f5;">Sat</th>
        </tr>
    """
    
    mood_colors = ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff']
    mood_labels = ['Very Sad', 'Sad', 'Neutral', 'Happy', 'Very Happy']
    
    # Find the start of the week for our start_date
    days_since_sunday = start_date.weekday() + 1 if start_date.weekday() != 6 else 0
    calendar_start = start_date - timedelta(days=days_since_sunday)
    
    # Find the end of the week for our end_date
    days_to_saturday = 6 - end_date.weekday() if end_date.weekday() != 6 else 0
    calendar_end = end_date + timedelta(days=days_to_saturday)
    
    # Pre-calculate all dates to analyze month boundaries
    all_dates = []
    current_date = calendar_start
    while current_date <= calendar_end:
        all_dates.append(current_date)
        current_date += timedelta(days=1)
    
    # Group dates into weeks
    weeks = []
    for i in range(0, len(all_dates), 7):
        weeks.append(all_dates[i:i+7])
    
    for week_index, week in enumerate(weeks):
        html += "<tr>"
        
        for day_index, current_date in enumerate(week):
            date_key = current_date.strftime('%Y-%m-%d')
            is_in_range = start_date <= current_date <= end_date
            
            # Check for month boundaries
            is_first_day_of_month = current_date.day == 1
            
            # Check if this week contains the first or last day of a month within our range
            current_month = current_date.month
            prev_date = current_date - timedelta(days=1) 
            next_date = current_date + timedelta(days=1)
            
            # Determine if we need month boundary borders
            borders = []
            
            # Left border: first day of month (except if it's Sunday)
            if is_first_day_of_month and day_index > 0:
                borders.append("border-left: 4px solid #333")
            
            # Top border: if this is the first week containing this month
            first_day_of_month = current_date.replace(day=1)
            if first_day_of_month >= calendar_start:
                # Find which week contains the first day of this month
                for check_week_idx, check_week in enumerate(weeks):
                    if first_day_of_month in check_week:
                        if week_index == check_week_idx and current_date.month == current_month:
                            borders.append("border-top: 4px solid #333")
                        break
            
            # Bottom border: if this is the last week containing this month
            last_day_of_month = (current_date.replace(day=1) + timedelta(days=32)).replace(day=1) - timedelta(days=1)
            if last_day_of_month <= calendar_end:
                # Find which week contains the last day of this month
                for check_week_idx, check_week in enumerate(weeks):
                    if last_day_of_month in check_week:
                        if week_index == check_week_idx and current_date.month == current_month:
                            borders.append("border-bottom: 4px solid #333")
                        break
            
            border_style = "; ".join(borders)
            if border_style:
                border_style = border_style + ";"
            
            if is_in_range:
                mood = moods.get(date_key)
                
                if mood:
                    # Check if we have a mood rating or just sleep data
                    if mood['rating'] is not None:
                        bg_color = mood_colors[mood['rating']]
                        mood_label = mood_labels[mood['rating']]
                        activities = ", ".join(mood['activities'][:2]) if mood['activities'] else ''
                        if len(mood['activities']) > 2:
                            activities += f" +{len(mood['activities']) - 2} more"
                        
                        # Handle comment with book emoji and tooltip
                        comment_display = ""
                        if mood['comment']:
                            # Escape quotes for HTML attribute
                            escaped_comment = mood['comment'].replace('"', '&quot;').replace("'", '&#39;')
                            comment_display = f' <span title="{escaped_comment}" style="cursor: help;">📖</span>'
                        
                        # Add sleep indicator if available
                        sleep_indicator = ""
                        if 'sleep_data' in mood:
                            sleep_hours = mood['sleep_data'].get('total_sleep_hours', 0)
                            sleep_indicator = f' <span title="{sleep_hours:.1f} hours of sleep" style="cursor: help;">😴</span>'
                        
                        # Add daily activity indicator if available
                        activity_indicator = ""
                        if 'daily_data' in mood:
                            steps = mood['daily_data'].get('steps', 0)
                            distance_km = mood['daily_data'].get('distance_meters', 0) / 1000
                            active_hours = mood['daily_data'].get('active_time_hours', 0)
                            activity_indicator = f' <span title="{steps:,} steps, {distance_km:.1f}km, {active_hours:.1f}h active" style="cursor: help;">👟</span>'
                        
                        cell_content = f"""
                        <div style="font-weight: bold; margin-bottom: 3px;">{current_date.day}{comment_display}{sleep_indicator}{activity_indicator}</div>
                        <div style="font-size: 0.8em; margin-bottom: 3px; color: #333;">{mood_label}</div>
                        {f'<div style="font-size: 0.7em; margin-bottom: 2px; color: #666;">{activities}</div>' if activities else ''}
                        """
                    else:
                        # Only sleep/daily data, no mood rating
                        bg_color = '#e8f4fd'  # Light blue for data-only entries
                        
                        # Build indicators and description
                        indicators = ""
                        descriptions = []
                        
                        if 'sleep_data' in mood:
                            sleep_hours = mood['sleep_data'].get('total_sleep_hours', 0)
                            indicators += f' <span title="{sleep_hours:.1f} hours of sleep" style="cursor: help;">😴</span>'
                            descriptions.append(f"{sleep_hours:.1f}h sleep")
                        
                        if 'daily_data' in mood:
                            steps = mood['daily_data'].get('steps', 0)
                            distance_km = mood['daily_data'].get('distance_meters', 0) / 1000
                            active_hours = mood['daily_data'].get('active_time_hours', 0)
                            indicators += f' <span title="{steps:,} steps, {distance_km:.1f}km, {active_hours:.1f}h active" style="cursor: help;">👟</span>'
                            descriptions.append(f"{steps:,} steps")
                        
                        description_text = ", ".join(descriptions) if descriptions else "Data available"
                        
                        cell_content = f"""
                        <div style="font-weight: bold; margin-bottom: 3px;">{current_date.day}{indicators}</div>
                        <div style="font-size: 0.8em; margin-bottom: 3px; color: #333;">Data only (no mood rating)</div>
                        <div style="font-size: 0.7em; margin-bottom: 2px; color: #666;">{description_text}</div>
                        """
                else:
                    bg_color = '#f9f9f9'
                    cell_content = f"""
                    <div style="font-weight: bold; margin-bottom: 3px;">{current_date.day}</div>
                    <div style="font-size: 0.8em; color: #999;">No entry</div>
                    """
            else:
                # Outside our date range - show as disabled
                bg_color = '#f0f0f0'
                cell_content = f'<div style="color: #ccc;">{current_date.day}</div>'
            
            html += f'''
            <td style="border: 1px solid #ddd; padding: 6px; background-color: {bg_color}; 
                       vertical-align: top; height: 80px; width: 14.28%; {border_style}">
                {cell_content}
            </td>
            '''
        
        html += "</tr>"
    
    html += "</table>"
    
    # Add legend
    html += """
    <div style="margin-top: 20px;">
        <h3>Mood Legend</h3>
        <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffb3ba; margin-right: 5px; border: 1px solid #ddd;"></span>Very Sad (0)</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffdfba; margin-right: 5px; border: 1px solid #ddd;"></span>Sad (1)</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #ffffba; margin-right: 5px; border: 1px solid #ddd;"></span>Neutral (2)</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #baffc9; margin-right: 5px; border: 1px solid #ddd;"></span>Happy (3)</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #bae1ff; margin-right: 5px; border: 1px solid #ddd;"></span>Very Happy (4)</div>
            <div><span style="display: inline-block; width: 20px; height: 20px; background-color: #e8f4fd; margin-right: 5px; border: 1px solid #ddd;"></span>Data only (no mood rating)</div>
            <div><span style="margin-left: 10px;">📖 = Has comment (hover for details)</span></div>
            <div><span style="margin-left: 10px;">😴 = Sleep data available</span></div>
            <div><span style="margin-left: 10px;">👟 = Daily activity data available</span></div>
        </div>
        <p style="margin-top: 10px; font-size: 0.9em; color: #666;">
            <strong>Note:</strong> Thick borders indicate month boundaries. Grayed out days are outside the 30-day period.
        </p>
    </div>
    """
    
    return html

def send_email(to_email, calendar_html, basic_stats, openai_insights, start_date, end_date, user_id):
    subject = "Moodful - Your Last 30 Days Mood Summary"
    
    # Get or create unsubscribe token for this user
    unsubscribe_token = get_or_create_unsubscribe_token(user_id)
    unsubscribe_link = f"{BASE_URL}/api/user/unsubscribe?token={unsubscribe_token}&type=weekly"
    unsubscribe_all_link = f"{BASE_URL}/api/user/unsubscribe?token={unsubscribe_token}&type=all"
    
    # Generate the email body
    email_body = f"""
    <p>Here's some mood statistics for the period from {start_date.strftime('%B %d, %Y')} to {end_date.strftime('%B %d, %Y')}:</p>
    """

    for i, stat in enumerate(basic_stats, start=1):
        email_body += f"<p>{i}. **{stat['name']}**: {stat['description']}\n\n</p>"

    html_content = f"""
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Last 30 Days Mood Summary - Moodful</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
    """

    # Add AI insights first if available
    if openai_insights:
        html_content += f"""
        <h2 style="color: #6a89cc;">AI-Generated Insights</h2>
        """
        for insight in openai_insights:
            html_content += f"""
            <h3>{insight['name']}</h3>
            <p>{insight['description']}</p>
            """

    # Then add Basic Analytics
    html_content += f"""
        <h2 style="color: #6a89cc;">Basic Analytics</h2>
        {email_body}
        <h2 style="color: #6a89cc;">Your Last 30 Days Overview</h2>
        <p>Here's a summary of your mood entries for the last 30 days:</p>
        {calendar_html}
    """

    html_content += f"""
        <p>Remember, focusing on the positive aspects of your day can help maintain and even improve your mood. Keep up the great work tracking your mood!</p>
        <p>Best regards,
        <br/>Your Moodful</p>
        <div style="margin-top: 30px; font-size: 0.9em; color: #888; border-top: 1px solid #ddd; padding-top: 15px;">
            <p>If you no longer wish to receive summary emails, you can <a href="{unsubscribe_link}">unsubscribe from summary emails</a>.</p>
            <p>Or if you wish to unsubscribe from all emails, you can <a href="{unsubscribe_all_link}">unsubscribe from all Moodful emails</a>.</p>
        </div>
    </body>
    </html>
    """

    try:
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
            auth=("api", MAILGUN_API_KEY),
            data={
                "from": f"Moodful <{SENDER_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content
            }
        )
        response.raise_for_status()
        print(f"Email sent successfully to {to_email}")
    except requests.exceptions.RequestException as e:
        print(f"Failed to send email to {to_email}. Error: {str(e)}")

def get_positive_words():
    return set(opinion_lexicon.positive())

def get_stress_words():
    stress_synsets = wordnet.synsets('stress') + wordnet.synsets('anxiety') + wordnet.synsets('fatigue')
    stress_words = set()
    for synset in stress_synsets:
        stress_words.update(lemma.name() for lemma in synset.lemmas())
    return stress_words

def generate_mood_summary(user_id, start_date, end_date):
    # Connect to the database
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Fetch mood data for the given date range
    cursor.execute("""
        SELECT datetime, rating, comment, activities
        FROM moods
        WHERE userId = ? AND datetime BETWEEN ? AND ?
        ORDER BY datetime
    """, (user_id, start_date.isoformat(), end_date.isoformat()))

    data = []
    for row in cursor.fetchall():
        datetime_str, rating, encrypted_comment, activities_str = row
        dt = datetime.fromisoformat(datetime_str.replace('Z', '+00:00'))
        # Make all datetimes offset-naive (local time)
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        entry = {
            'datetime': dt,
            'rating': rating,
            'comment': decrypt(encrypted_comment) if encrypted_comment else None,
            'activities': json.loads(activities_str) if activities_str else []
        }
        data.append(entry)

    # Close the database connection
    conn.close()

    # Sort data by datetime
    data.sort(key=lambda x: x['datetime'])

    # Check if we have any data
    if not data:
        return [{'name': 'No Data', 'description': 'No mood entries were found for this time period.'}]

    # 1. Average Mood Rating
    total_ratings = [entry['rating'] for entry in data]
    average_mood = sum(total_ratings) / len(total_ratings)

    # 2. Highest Mood Day
    highest_mood_entry = max(data, key=lambda x: x['rating'])
    highest_mood_day = highest_mood_entry['datetime'].strftime('%A, %B %d, %Y')
    highest_mood_rating = highest_mood_entry['rating']
    highest_mood_comment = highest_mood_entry['comment']

    # 3. Mood Change (compared to previous week)
    today = end_date.date()
    last_week = [entry for entry in data if (today - entry['datetime'].date()).days <= 7]
    previous_week = [entry for entry in data if 7 < (today - entry['datetime'].date()).days <= 14]

    if last_week and previous_week:
        last_week_avg = sum(entry['rating'] for entry in last_week) / len(last_week)
        previous_week_avg = sum(entry['rating'] for entry in previous_week) / len(previous_week)
        if previous_week_avg != 0:
            mood_improvement = ((last_week_avg - previous_week_avg) / previous_week_avg) * 100
        else:
            mood_improvement = None
    else:
        mood_improvement = None

    # 4. Most Enjoyed Activity
    activity_counts = Counter()
    for entry in data:
        activity_counts.update(entry['activities'])
    if activity_counts:
        most_enjoyed_activity = activity_counts.most_common(1)[0][0]
    else:
        most_enjoyed_activity = None

    # 5. Activities Boosting Mood
    activity_mood = defaultdict(list)
    for entry in data:
        rating = entry['rating']
        activities = entry['activities']
        for activity in activities:
            activity_mood[activity].append(rating)

    activity_avg_mood = {}
    for activity, ratings in activity_mood.items():
        avg_rating = sum(ratings) / len(ratings)
        activity_avg_mood[activity] = avg_rating

    boosting_activities = [activity for activity, avg_rating in activity_avg_mood.items() if avg_rating >= average_mood]

    # 6. Positive Words Count
    positive_words = get_positive_words()
    positive_word_count = 0
    for entry in data:
        if entry['comment']:
            comment = entry['comment'].lower()
            words = set(re.findall(r'\b\w+\b', comment))
            positive_word_count += len(words.intersection(positive_words))

    # 7. Sleep and Mood Correlation (Activity-based)
    sleep_related_entries = [entry for entry in data if 'good sleep' in entry['activities']]
    if sleep_related_entries:
        sleep_ratings = [entry['rating'] for entry in sleep_related_entries]
        avg_sleep_mood = sum(sleep_ratings) / len(sleep_ratings)
    else:
        avg_sleep_mood = None

    # New Sleep Data Analysis (only if sleep data is available)
    sleep_data_entries = []
    for entry in data:
        # Check if we have sleep data stored in the mood summary
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT calendarDate, durationInHours, deepSleepDurationInHours, 
                   lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
                   startTimeInSeconds, startTimeOffsetInSeconds
            FROM sleep_summaries
            WHERE userId = ? AND calendarDate = ?
        """, (user_id, entry['datetime'].strftime('%Y-%m-%d')))
        sleep_row = cursor.fetchone()
        conn.close()
        
        if sleep_row:
            sleep_entry = entry.copy()
            sleep_entry['sleep_data'] = {
                'total_sleep_hours': sleep_row[1] if sleep_row[1] else 0,
                'deep_sleep_hours': sleep_row[2] if sleep_row[2] else 0,
                'light_sleep_hours': sleep_row[3] if sleep_row[3] else 0,
                'rem_sleep_hours': sleep_row[4] if sleep_row[4] else 0,
                'awake_hours': sleep_row[5] if sleep_row[5] else 0,
                'start_time_seconds': sleep_row[6] if sleep_row[6] else None,
                'start_time_offset_seconds': sleep_row[7] if sleep_row[7] else None
            }
            sleep_data_entries.append(sleep_entry)

    # Sleep Duration and Mood Correlation
    sleep_duration_mood_correlation = None
    avg_sleep_duration = None
    if sleep_data_entries:
        sleep_durations = [entry['sleep_data']['total_sleep_hours'] for entry in sleep_data_entries]
        sleep_moods = [entry['rating'] for entry in sleep_data_entries]
        avg_sleep_duration = sum(sleep_durations) / len(sleep_durations)
        
        # Calculate correlation coefficient
        if len(sleep_durations) > 1:
            mean_sleep = sum(sleep_durations) / len(sleep_durations)
            mean_mood = sum(sleep_moods) / len(sleep_moods)
            
            numerator = sum((s - mean_sleep) * (m - mean_mood) for s, m in zip(sleep_durations, sleep_moods))
            sleep_variance = sum((s - mean_sleep) ** 2 for s in sleep_durations)
            mood_variance = sum((m - mean_mood) ** 2 for m in sleep_moods)
            
            if sleep_variance > 0 and mood_variance > 0:
                sleep_duration_mood_correlation = numerator / (sleep_variance * mood_variance) ** 0.5

    # Deep Sleep and Mood Analysis
    deep_sleep_mood_correlation = None
    avg_deep_sleep = None
    if sleep_data_entries:
        deep_sleep_hours = [entry['sleep_data']['deep_sleep_hours'] for entry in sleep_data_entries if entry['sleep_data']['deep_sleep_hours'] > 0]
        if deep_sleep_hours:
            avg_deep_sleep = sum(deep_sleep_hours) / len(deep_sleep_hours)
            deep_sleep_moods = [entry['rating'] for entry in sleep_data_entries if entry['sleep_data']['deep_sleep_hours'] > 0]
            
            if len(deep_sleep_hours) > 1:
                mean_deep = sum(deep_sleep_hours) / len(deep_sleep_hours)
                mean_mood = sum(deep_sleep_moods) / len(deep_sleep_moods)
                
                numerator = sum((d - mean_deep) * (m - mean_mood) for d, m in zip(deep_sleep_hours, deep_sleep_moods))
                deep_variance = sum((d - mean_deep) ** 2 for d in deep_sleep_hours)
                mood_variance = sum((m - mean_mood) ** 2 for m in deep_sleep_moods)
                
                if deep_variance > 0 and mood_variance > 0:
                    deep_sleep_mood_correlation = numerator / (deep_variance * mood_variance) ** 0.5

    # Sleep Consistency Analysis
    sleep_consistency_score = None
    if sleep_data_entries and len(sleep_data_entries) > 1:
        sleep_durations = [entry['sleep_data']['total_sleep_hours'] for entry in sleep_data_entries]
        avg_duration = sum(sleep_durations) / len(sleep_durations)
        variance = sum((d - avg_duration) ** 2 for d in sleep_durations) / len(sleep_durations)
        std_dev = variance ** 0.5
        # Lower standard deviation = higher consistency (invert for score)
        sleep_consistency_score = max(0, 10 - std_dev * 2)  # Scale from 0-10

    # Best Sleep Quality Day
    best_sleep_day = None
    best_sleep_quality_score = None
    if sleep_data_entries:
        for entry in sleep_data_entries:
            sleep_data = entry['sleep_data']
            # Calculate sleep quality score (deep + REM sleep as percentage of total)
            total_sleep = sleep_data['total_sleep_hours']
            if total_sleep > 0:
                quality_sleep = sleep_data['deep_sleep_hours'] + sleep_data['rem_sleep_hours']
                quality_score = (quality_sleep / total_sleep) * 100
                
                if best_sleep_quality_score is None or quality_score > best_sleep_quality_score:
                    best_sleep_quality_score = quality_score
                    best_sleep_day = entry['datetime'].strftime('%A, %B %d, %Y')

    # Sleep Debt Analysis
    sleep_debt_days = None
    recommended_sleep = 8.0  # hours
    if sleep_data_entries:
        short_sleep_days = [entry for entry in sleep_data_entries if entry['sleep_data']['total_sleep_hours'] < recommended_sleep]
        sleep_debt_days = len(short_sleep_days)

    # Bedtime Consistency
    bedtime_consistency = None
    avg_bedtime = None
    if sleep_data_entries:
        bedtimes = []
        for entry in sleep_data_entries:
            start_time = entry['sleep_data']['start_time_seconds']
            if start_time:
                # Convert to hours from midnight
                bedtime_hour = (start_time % 86400) / 3600
                # Normalize late bedtimes (e.g., 23:00 = -1, 01:00 = 1)
                if bedtime_hour > 12:
                    bedtime_hour = bedtime_hour - 24
                bedtimes.append(bedtime_hour)
        
        if bedtimes:
            avg_bedtime = sum(bedtimes) / len(bedtimes)
            if len(bedtimes) > 1:
                variance = sum((b - avg_bedtime) ** 2 for b in bedtimes) / len(bedtimes)
                std_dev = variance ** 0.5
                bedtime_consistency = max(0, 10 - std_dev)  # Higher score = more consistent

    # Weekend vs Weekday Sleep
    weekday_sleep_avg = None
    weekend_sleep_avg = None
    if sleep_data_entries:
        weekday_sleep = [entry['sleep_data']['total_sleep_hours'] for entry in sleep_data_entries if entry['datetime'].weekday() < 5]
        weekend_sleep = [entry['sleep_data']['total_sleep_hours'] for entry in sleep_data_entries if entry['datetime'].weekday() >= 5]
        
        if weekday_sleep:
            weekday_sleep_avg = sum(weekday_sleep) / len(weekday_sleep)
        if weekend_sleep:
            weekend_sleep_avg = sum(weekend_sleep) / len(weekend_sleep)

    # New Daily Activity Data Analysis (only if daily data is available)
    daily_data_entries = []
    for entry in data:
        # Check if we have daily activity data stored
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT calendarDate, steps, distanceInMeters, activeTimeInHours, 
                   floorsClimbed, averageStressLevel, maxStressLevel, stressDurationInMinutes
            FROM daily_summaries
            WHERE userId = ? AND calendarDate = ?
        """, (user_id, entry['datetime'].strftime('%Y-%m-%d')))
        daily_row = cursor.fetchone()
        conn.close()
        
        if daily_row:
            daily_entry = entry.copy()
            daily_entry['daily_data'] = {
                'steps': daily_row[1] if daily_row[1] else 0,
                'distance_meters': daily_row[2] if daily_row[2] else 0,
                'active_time_hours': daily_row[3] if daily_row[3] else 0,
                'floors_climbed': daily_row[4] if daily_row[4] else 0,
                'average_stress_level': daily_row[5] if daily_row[5] else None,
                'max_stress_level': daily_row[6] if daily_row[6] else None,
                'stress_duration_minutes': daily_row[7] if daily_row[7] else 0
            }
            daily_data_entries.append(daily_entry)

    # Steps and Mood Correlation
    steps_mood_correlation = None
    avg_daily_steps = None
    if daily_data_entries:
        daily_steps = [entry['daily_data']['steps'] for entry in daily_data_entries]
        steps_moods = [entry['rating'] for entry in daily_data_entries]
        avg_daily_steps = sum(daily_steps) / len(daily_steps)
        
        # Calculate correlation coefficient
        if len(daily_steps) > 1:
            mean_steps = sum(daily_steps) / len(daily_steps)
            mean_mood = sum(steps_moods) / len(steps_moods)
            
            numerator = sum((s - mean_steps) * (m - mean_mood) for s, m in zip(daily_steps, steps_moods))
            steps_variance = sum((s - mean_steps) ** 2 for s in daily_steps)
            mood_variance = sum((m - mean_mood) ** 2 for m in steps_moods)
            
            if steps_variance > 0 and mood_variance > 0:
                steps_mood_correlation = numerator / (steps_variance * mood_variance) ** 0.5

    # Most Active Day
    most_active_day = None
    highest_step_count = None
    if daily_data_entries:
        most_active_entry = max(daily_data_entries, key=lambda x: x['daily_data']['steps'])
        most_active_day = most_active_entry['datetime'].strftime('%A, %B %d, %Y')
        highest_step_count = most_active_entry['daily_data']['steps']

    # Active Time and Mood Analysis
    active_time_mood_correlation = None
    avg_active_time = None
    if daily_data_entries:
        active_times = [entry['daily_data']['active_time_hours'] for entry in daily_data_entries if entry['daily_data']['active_time_hours'] > 0]
        if active_times:
            avg_active_time = sum(active_times) / len(active_times)
            active_time_moods = [entry['rating'] for entry in daily_data_entries if entry['daily_data']['active_time_hours'] > 0]
            
            if len(active_times) > 1:
                mean_active = sum(active_times) / len(active_times)
                mean_mood = sum(active_time_moods) / len(active_time_moods)
                
                numerator = sum((a - mean_active) * (m - mean_mood) for a, m in zip(active_times, active_time_moods))
                active_variance = sum((a - mean_active) ** 2 for a in active_times)
                mood_variance = sum((m - mean_mood) ** 2 for m in active_time_moods)
                
                if active_variance > 0 and mood_variance > 0:
                    active_time_mood_correlation = numerator / (active_variance * mood_variance) ** 0.5

    # Distance Traveled Analysis
    avg_daily_distance_km = None
    distance_mood_correlation = None
    if daily_data_entries:
        distances_km = [entry['daily_data']['distance_meters'] / 1000 for entry in daily_data_entries if entry['daily_data']['distance_meters'] > 0]
        if distances_km:
            avg_daily_distance_km = sum(distances_km) / len(distances_km)
            distance_moods = [entry['rating'] for entry in daily_data_entries if entry['daily_data']['distance_meters'] > 0]
            
            if len(distances_km) > 1:
                mean_distance = sum(distances_km) / len(distances_km)
                mean_mood = sum(distance_moods) / len(distance_moods)
                
                numerator = sum((d - mean_distance) * (m - mean_mood) for d, m in zip(distances_km, distance_moods))
                distance_variance = sum((d - mean_distance) ** 2 for d in distances_km)
                mood_variance = sum((m - mean_mood) ** 2 for m in distance_moods)
                
                if distance_variance > 0 and mood_variance > 0:
                    distance_mood_correlation = numerator / (distance_variance * mood_variance) ** 0.5

    # Stress Level Analysis
    avg_stress_level = None
    stress_mood_correlation = None
    high_stress_days = None
    if daily_data_entries:
        stress_levels = [entry['daily_data']['average_stress_level'] for entry in daily_data_entries if entry['daily_data']['average_stress_level'] is not None]
        if stress_levels:
            avg_stress_level = sum(stress_levels) / len(stress_levels)
            stress_moods = [entry['rating'] for entry in daily_data_entries if entry['daily_data']['average_stress_level'] is not None]
            
            # Count high stress days (>= 70 on 0-100 scale)
            high_stress_days = len([level for level in stress_levels if level >= 70])
            
            if len(stress_levels) > 1:
                mean_stress = sum(stress_levels) / len(stress_levels)
                mean_mood = sum(stress_moods) / len(stress_moods)
                
                numerator = sum((s - mean_stress) * (m - mean_mood) for s, m in zip(stress_levels, stress_moods))
                stress_variance = sum((s - mean_stress) ** 2 for s in stress_levels)
                mood_variance = sum((m - mean_mood) ** 2 for m in stress_moods)
                
                if stress_variance > 0 and mood_variance > 0:
                    stress_mood_correlation = numerator / (stress_variance * mood_variance) ** 0.5

    # Activity Consistency Analysis
    activity_consistency_score = None
    if daily_data_entries and len(daily_data_entries) > 1:
        daily_steps = [entry['daily_data']['steps'] for entry in daily_data_entries]
        avg_steps = sum(daily_steps) / len(daily_steps)
        variance = sum((s - avg_steps) ** 2 for s in daily_steps) / len(daily_steps)
        std_dev = variance ** 0.5
        # Lower standard deviation = higher consistency (invert for score)
        if avg_steps > 0:
            activity_consistency_score = max(0, 10 - (std_dev / avg_steps) * 20)  # Scale from 0-10

    # Weekend vs Weekday Activity
    weekday_steps_avg = None
    weekend_steps_avg = None
    weekday_active_time_avg = None
    weekend_active_time_avg = None
    if daily_data_entries:
        weekday_steps = [entry['daily_data']['steps'] for entry in daily_data_entries if entry['datetime'].weekday() < 5]
        weekend_steps = [entry['daily_data']['steps'] for entry in daily_data_entries if entry['datetime'].weekday() >= 5]
        weekday_active = [entry['daily_data']['active_time_hours'] for entry in daily_data_entries if entry['datetime'].weekday() < 5]
        weekend_active = [entry['daily_data']['active_time_hours'] for entry in daily_data_entries if entry['datetime'].weekday() >= 5]
        
        if weekday_steps:
            weekday_steps_avg = sum(weekday_steps) / len(weekday_steps)
        if weekend_steps:
            weekend_steps_avg = sum(weekend_steps) / len(weekend_steps)
        if weekday_active:
            weekday_active_time_avg = sum(weekday_active) / len(weekday_active)
        if weekend_active:
            weekend_active_time_avg = sum(weekend_active) / len(weekend_active)

    # Floors Climbed Analysis
    avg_floors_climbed = None
    floors_mood_correlation = None
    if daily_data_entries:
        floors_data = [entry['daily_data']['floors_climbed'] for entry in daily_data_entries if entry['daily_data']['floors_climbed'] > 0]
        if floors_data:
            avg_floors_climbed = sum(floors_data) / len(floors_data)
            floors_moods = [entry['rating'] for entry in daily_data_entries if entry['daily_data']['floors_climbed'] > 0]
            
            if len(floors_data) > 1:
                mean_floors = sum(floors_data) / len(floors_data)
                mean_mood = sum(floors_moods) / len(floors_moods)
                
                numerator = sum((f - mean_floors) * (m - mean_mood) for f, m in zip(floors_data, floors_moods))
                floors_variance = sum((f - mean_floors) ** 2 for f in floors_data)
                mood_variance = sum((m - mean_mood) ** 2 for m in floors_moods)
                
                if floors_variance > 0 and mood_variance > 0:
                    floors_mood_correlation = numerator / (floors_variance * mood_variance) ** 0.5

    # 9. Physical Activity Benefits
    physical_activities = ['sports', 'hockey', 'baseball', 'mma', 'basketball', 'soccer', 'football', 'tennis', 'golf', 'swimming', 'running', 'yoga', 'meditation', 'workout', 'exercise', 'bike', 'walk', 'hike', 'climbing', 'weightlifting', 'pilates', 'dance', 'gym', 'yoga', 'meditation', 'workout', 'exercise', 'bike', 'walk', 'hike', 'climbing', 'weightlifting', 'pilates', 'dance', 'gym']
    physical_entries = [entry for entry in data if any(activity in entry['activities'] for activity in physical_activities)]
    if physical_entries:
        physical_ratings = [entry['rating'] for entry in physical_entries]
        avg_physical_mood = sum(physical_ratings) / len(physical_ratings)
    else:
        avg_physical_mood = None

    # 10. Consistency in Tracking
    total_days = (end_date - start_date).days + 1
    days_logged = len(set(entry['datetime'].date() for entry in data))
    consistency_percentage = (days_logged / total_days) * 100 if total_days > 0 else None

    # 11. New Experiences
    # Not enough data to determine new experiences

    # 12. Weekend vs. Weekday Mood
    weekday_ratings = [entry['rating'] for entry in data if entry['datetime'].weekday() < 5]
    weekend_ratings = [entry['rating'] for entry in data if entry['datetime'].weekday() >= 5]

    if weekday_ratings:
        avg_weekday_mood = sum(weekday_ratings) / len(weekday_ratings)
    else:
        avg_weekday_mood = None

    if weekend_ratings:
        avg_weekend_mood = sum(weekend_ratings) / len(weekend_ratings)
    else:
        avg_weekend_mood = None

    # 13. Early Riser Effect
    early_riser_entries = [entry for entry in data if entry['comment'] and 'woke up early' in entry['comment'].lower()]
    if early_riser_entries:
        early_riser_ratings = [entry['rating'] for entry in early_riser_entries]
        avg_early_riser_mood = sum(early_riser_ratings) / len(early_riser_ratings)
    else:
        avg_early_riser_mood = None

    # 14. Work Satisfaction Influence
    work_related_entries = [entry for entry in data if entry['comment'] and 'work' in entry['comment'].lower()]
    if work_related_entries:
        work_ratings = [entry['rating'] for entry in work_related_entries]
        avg_work_mood = sum(work_ratings) / len(work_ratings)
    else:
        avg_work_mood = None

    # 15. Family Time Impact
    family_related_entries = [entry for entry in data if entry['comment'] and any(word in entry['comment'].lower() for word in ['family', 'kid', 'son', 'daughter', 'mom', 'dad', 'father', 'mother'])]
    if family_related_entries:
        family_ratings = [entry['rating'] for entry in family_related_entries]
        avg_family_mood = sum(family_ratings) / len(family_ratings)
    else:
        avg_family_mood = None

    # 16. Progress Towards Goals
    progress_keywords = ['progress', 'built', 'started', 'improvement', 'developed', 'made', 'set up', 'fixed', 'got', 'solved', 'showed', 'effort']
    progress_entries = []
    for entry in data:
        if entry['comment']:
            comment = entry['comment'].lower()
            if any(keyword in comment for keyword in progress_keywords):
                progress_entries.append(entry)

    if progress_entries:
        progress_ratings = [entry['rating'] for entry in progress_entries]
        avg_progress_mood = sum(progress_ratings) / len(progress_ratings)
    else:
        avg_progress_mood = None

    # 17. Stress Reduction Indicators
    stress_words = get_stress_words()
    stress_word_count = 0
    for entry in data:
        if entry['comment']:
            comment = entry['comment'].lower()
            words = set(re.findall(r'\b\w+\b', comment))
            stress_word_count += len(words.intersection(stress_words))

    # 18. Positive Outlook Percentage
    positive_days = [entry for entry in data if entry['rating'] >= 3]
    positive_percentage = (len(positive_days) / len(data)) * 100

    # Initialize statistics list before using it
    statistics = []

    # Now, create a list of dictionaries with name-description pairs
    statistics = [
        {'name': 'Average Mood Rating', 'description': f'Your average mood rating this week was {average_mood:.2f}.'},
        {'name': 'Highest Mood Day', 'description': f'On {highest_mood_day}, you had your highest mood rating of {highest_mood_rating}. You mentioned: "{highest_mood_comment}"'},
    ]

    # 19. Most Detailed Journal Entry
    entries_with_comments = [entry for entry in data if entry['comment'] is not None]
    if entries_with_comments:
        most_detailed_entry = max(entries_with_comments, key=lambda x: len(x['comment']))
        most_detailed_day = most_detailed_entry['datetime'].strftime('%A, %B %d, %Y')
        most_detailed_comment = most_detailed_entry['comment']
        statistics.append({'name': 'Most Detailed Journal Entry', 'description': f'Your most detailed entry was on {most_detailed_day}: "{most_detailed_comment}"'})

    if mood_improvement is not None:
        statistics.append({'name': 'Mood Improvement', 'description': f'Your mood changed by {mood_improvement:.1f}% compared to the previous week.'})
    
    if most_enjoyed_activity:
        statistics.append({'name': 'Most Enjoyed Activity', 'description': f'You most frequently engaged in "{most_enjoyed_activity}" this week.'})
    if boosting_activities:
        statistics.append({'name': 'Activities Boosting Mood', 'description': f'Activities like {", ".join(boosting_activities)} are associated with higher mood ratings.'})
    statistics.append({'name': 'Positive Words Count', 'description': f'You used {positive_word_count} positive words in your journal entries this week.'})
    if avg_sleep_mood is not None:
        statistics.append({'name': 'Sleep and Mood Correlation', 'description': f'When you had good sleep, your average mood was {avg_sleep_mood:.2f}.'})
    
    # Add new sleep-based insights
    if avg_sleep_duration is not None:
        statistics.append({'name': 'Average Sleep Duration', 'description': f'Your average sleep duration was {avg_sleep_duration:.1f} hours per night.'})
    
    if sleep_duration_mood_correlation is not None:
        if sleep_duration_mood_correlation > 0.3:
            correlation_desc = "strong positive"
        elif sleep_duration_mood_correlation > 0.1:
            correlation_desc = "moderate positive"
        elif sleep_duration_mood_correlation < -0.3:
            correlation_desc = "strong negative"
        elif sleep_duration_mood_correlation < -0.1:
            correlation_desc = "moderate negative"
        else:
            correlation_desc = "weak"
        statistics.append({'name': 'Sleep Duration Impact', 'description': f'Your sleep duration shows a {correlation_desc} correlation with mood (r={sleep_duration_mood_correlation:.2f}).'})
    
    if avg_deep_sleep is not None:
        statistics.append({'name': 'Deep Sleep Quality', 'description': f'You averaged {avg_deep_sleep:.1f} hours of deep sleep per night.'})
    
    if deep_sleep_mood_correlation is not None and deep_sleep_mood_correlation > 0.2:
        statistics.append({'name': 'Deep Sleep Benefits', 'description': f'More deep sleep correlates with better moods (r={deep_sleep_mood_correlation:.2f}).'})
    
    if sleep_consistency_score is not None:
        if sleep_consistency_score >= 8:
            consistency_desc = "very consistent"
        elif sleep_consistency_score >= 6:
            consistency_desc = "fairly consistent"
        elif sleep_consistency_score >= 4:
            consistency_desc = "somewhat inconsistent"
        else:
            consistency_desc = "quite inconsistent"
        statistics.append({'name': 'Sleep Schedule Consistency', 'description': f'Your sleep schedule was {consistency_desc} (consistency score: {sleep_consistency_score:.1f}/10).'})
    
    if best_sleep_day is not None and best_sleep_quality_score is not None:
        statistics.append({'name': 'Best Sleep Quality Day', 'description': f'Your best sleep quality was on {best_sleep_day} with {best_sleep_quality_score:.1f}% deep and REM sleep.'})
    
    if sleep_debt_days is not None:
        total_sleep_nights = len(sleep_data_entries)
        debt_percentage = (sleep_debt_days / total_sleep_nights) * 100 if total_sleep_nights > 0 else 0
        statistics.append({'name': 'Sleep Debt Analysis', 'description': f'You had less than 8 hours of sleep on {sleep_debt_days} out of {total_sleep_nights} nights ({debt_percentage:.0f}%).'})
    
    if bedtime_consistency is not None and avg_bedtime is not None:
        # Convert avg_bedtime back to readable format
        if avg_bedtime < 0:
            bedtime_str = f"{int(24 + avg_bedtime):02d}:{int((avg_bedtime % 1) * 60):02d}"
        else:
            bedtime_str = f"{int(avg_bedtime):02d}:{int((avg_bedtime % 1) * 60):02d}"
        
        if bedtime_consistency >= 8:
            consistency_desc = "very consistent"
        elif bedtime_consistency >= 6:
            consistency_desc = "fairly consistent"
        else:
            consistency_desc = "inconsistent"
        statistics.append({'name': 'Bedtime Consistency', 'description': f'Your average bedtime was {bedtime_str} with {consistency_desc} timing (score: {bedtime_consistency:.1f}/10).'})
    
    if weekday_sleep_avg is not None and weekend_sleep_avg is not None:
        sleep_difference = weekend_sleep_avg - weekday_sleep_avg
        if abs(sleep_difference) > 0.5:
            if sleep_difference > 0:
                statistics.append({'name': 'Weekend Sleep Pattern', 'description': f'You sleep {sleep_difference:.1f} hours more on weekends ({weekend_sleep_avg:.1f}h) than weekdays ({weekday_sleep_avg:.1f}h).'})
            else:
                statistics.append({'name': 'Weekend Sleep Pattern', 'description': f'You sleep {abs(sleep_difference):.1f} hours less on weekends ({weekend_sleep_avg:.1f}h) than weekdays ({weekday_sleep_avg:.1f}h).'})
        else:
            statistics.append({'name': 'Weekend Sleep Pattern', 'description': f'Your sleep duration is consistent between weekdays ({weekday_sleep_avg:.1f}h) and weekends ({weekend_sleep_avg:.1f}h).'})
    
    # Add daily activity-based insights
    if avg_daily_steps is not None:
        statistics.append({'name': 'Average Daily Steps', 'description': f'You averaged {avg_daily_steps:,.0f} steps per day during this period.'})
    
    if most_active_day is not None and highest_step_count is not None:
        statistics.append({'name': 'Most Active Day', 'description': f'Your most active day was {most_active_day} with {highest_step_count:,} steps.'})
    
    if steps_mood_correlation is not None:
        if steps_mood_correlation > 0.3:
            correlation_desc = "strong positive"
        elif steps_mood_correlation > 0.1:
            correlation_desc = "moderate positive"
        elif steps_mood_correlation < -0.3:
            correlation_desc = "strong negative"
        elif steps_mood_correlation < -0.1:
            correlation_desc = "moderate negative"
        else:
            correlation_desc = "weak"
        statistics.append({'name': 'Steps and Mood Impact', 'description': f'Your daily step count shows a {correlation_desc} correlation with mood (r={steps_mood_correlation:.2f}).'})
    
    if avg_active_time is not None:
        statistics.append({'name': 'Active Time Benefits', 'description': f'You averaged {avg_active_time:.1f} hours of active movement per day.'})
    
    if active_time_mood_correlation is not None and active_time_mood_correlation > 0.2:
        statistics.append({'name': 'Active Time Impact', 'description': f'More active time correlates with better moods (r={active_time_mood_correlation:.2f}).'})
    
    if avg_daily_distance_km is not None:
        statistics.append({'name': 'Daily Distance Traveled', 'description': f'You averaged {avg_daily_distance_km:.1f} km of travel per day.'})
    
    if distance_mood_correlation is not None and distance_mood_correlation > 0.2:
        statistics.append({'name': 'Distance and Mood', 'description': f'Greater daily distance correlates with improved mood (r={distance_mood_correlation:.2f}).'})
    
    if avg_stress_level is not None:
        stress_level_desc = "low" if avg_stress_level < 30 else "moderate" if avg_stress_level < 60 else "high"
        statistics.append({'name': 'Average Stress Level', 'description': f'Your average stress level was {avg_stress_level:.0f}/100 ({stress_level_desc}).'})
    
    if high_stress_days is not None and len(daily_data_entries) > 0:
        stress_percentage = (high_stress_days / len(daily_data_entries)) * 100
        statistics.append({'name': 'High Stress Days', 'description': f'You experienced high stress (≥70/100) on {high_stress_days} out of {len(daily_data_entries)} days ({stress_percentage:.0f}%).'})
    
    if stress_mood_correlation is not None and stress_mood_correlation < -0.2:
        statistics.append({'name': 'Stress Impact on Mood', 'description': f'Higher stress levels correlate with lower moods (r={stress_mood_correlation:.2f}).'})
    
    if activity_consistency_score is not None:
        if activity_consistency_score >= 8:
            consistency_desc = "very consistent"
        elif activity_consistency_score >= 6:
            consistency_desc = "fairly consistent"
        elif activity_consistency_score >= 4:
            consistency_desc = "somewhat inconsistent"
        else:
            consistency_desc = "quite inconsistent"
        statistics.append({'name': 'Activity Consistency', 'description': f'Your daily activity levels were {consistency_desc} (consistency score: {activity_consistency_score:.1f}/10).'})
    
    if weekday_steps_avg is not None and weekend_steps_avg is not None:
        steps_difference = weekend_steps_avg - weekday_steps_avg
        if abs(steps_difference) > 1000:
            if steps_difference > 0:
                statistics.append({'name': 'Weekend Activity Pattern', 'description': f'You take {steps_difference:,.0f} more steps on weekends ({weekend_steps_avg:,.0f}) than weekdays ({weekday_steps_avg:,.0f}).'})
            else:
                statistics.append({'name': 'Weekend Activity Pattern', 'description': f'You take {abs(steps_difference):,.0f} fewer steps on weekends ({weekend_steps_avg:,.0f}) than weekdays ({weekday_steps_avg:,.0f}).'})
        else:
            statistics.append({'name': 'Weekend Activity Pattern', 'description': f'Your step count is consistent between weekdays ({weekday_steps_avg:,.0f}) and weekends ({weekend_steps_avg:,.0f}).'})
    
    if avg_floors_climbed is not None:
        statistics.append({'name': 'Floors Climbed', 'description': f'You averaged {avg_floors_climbed:.1f} floors climbed per day.'})
    
    if floors_mood_correlation is not None and floors_mood_correlation > 0.2:
        statistics.append({'name': 'Vertical Activity Benefits', 'description': f'Climbing more floors correlates with better moods (r={floors_mood_correlation:.2f}).'})
    
    if avg_physical_mood is not None:
        statistics.append({'name': 'Physical Activity Benefits', 'description': f'Engaging in physical activities increased your mood to an average of {avg_physical_mood:.2f}.'})
    if consistency_percentage is not None:
        statistics.append({'name': 'Consistency in Tracking', 'description': f'You logged your mood on {days_logged} out of {total_days} days ({consistency_percentage:.1f}% consistency).'})
    if avg_weekday_mood is not None and avg_weekend_mood is not None:
        statistics.append({'name': 'Weekend vs. Weekday Mood', 'description': f'Your average weekend mood was {avg_weekend_mood:.2f} compared to {avg_weekday_mood:.2f} on weekdays.'})
    if avg_early_riser_mood is not None:
        statistics.append({'name': 'Early Riser Effect', 'description': f'On days you woke up early, your average mood was {avg_early_riser_mood:.2f}.'})
    if avg_work_mood is not None:
        statistics.append({'name': 'Work Satisfaction Influence', 'description': f'Work-related activities correlated with an average mood of {avg_work_mood:.2f}.'})
    if avg_family_mood is not None:
        statistics.append({'name': 'Family Time Impact', 'description': f'Spending time with family increased your mood to an average of {avg_family_mood:.2f}.'})
    if avg_progress_mood is not None:
        statistics.append({'name': 'Progress Towards Goals', 'description': f'Making progress on your goals raised your mood to an average of {avg_progress_mood:.2f}.'})
    statistics.append({'name': 'Positive Outlook Percentage', 'description': f'{positive_percentage:.1f}% of your days had a mood rating of 3 or higher.'})
    
    random_statistics = random.sample(statistics, min(4, len(statistics)))
    return random_statistics

def get_openai_insights(moods):
    current_date = datetime.now().strftime('%Y-%m-%d')
    prompt = """
    Assume today's date is {current_date}.

    You will be given mood data in JSON format for the previous month. This data includes mood entries, sleep data, and daily activity data from Garmin devices. For each question below, provide a concise answer in JSON format, using 'Answer#' as the key.

    **Instructions:**

    - ALL answers should be roughly 50 to 80 words.
    - Answers must be clear, concise, and supported by specific examples or evidence from the data.
    - Do not repeat the questions.
    - Only output JSON, no extra text or explanation.
    - For each answer, reference at least one relevant date and activity/comment/sleep/daily data from the sample data.
    - For predictions, only give positive predictions based on trends you observe.
    - For 'small win', it must be a positive event from the last 7 days, with encouragement to celebrate it.
    - For 'prediction', it must be a positive prediction for the upcoming week, based on recent patterns.
    - For 'insights', analyze relationships between mood ratings, activities, comments, sleep data, AND daily activity data if available.
    - For 'trends', look for correlations involving sleep quality, duration, physical activity levels, and mood patterns.

    **Questions:**

    1. What insights can you find about how comments, activities, sleep data, daily activity data, and mood ratings relate to one another?
    2. What are the most significant trends or correlations in the data from the past month, including sleep and activity patterns if available?
    3. Identify a small win from the past week. Include encouragement to celebrate this.
    4. Predict one positive thing that might happen with your moods next week, based on recent patterns including sleep and activity data if available.

    **Data Details:**
    - Mood ratings are on a scale from 0-4 where 0 is the worst mood and 4 is the best mood.
    - Activities are tags for activities, aspects, observations, etc. that the user can associate with mood entries outside of their comment.
    - Comments are freeform text optionally input by the user about their day.
    - Sleep data (when available) includes:
      * total_sleep_hours: Total sleep duration in hours
      * deep_sleep_hours: Deep sleep phase duration
      * light_sleep_hours: Light sleep phase duration  
      * rem_sleep_hours: REM sleep phase duration
      * awake_hours: Time spent awake during sleep period
      * start_time_seconds: Sleep start time (Unix timestamp)
    - Daily activity data (when available) includes:
      * steps: Number of steps taken during the day
      * distance_meters: Total distance traveled in meters
      * active_time_hours: Time spent in active movement in hours
      * floors_climbed: Number of floors climbed
      * average_stress_level: Average stress level (0-100 scale)
      * max_stress_level: Maximum stress level recorded
      * stress_duration_minutes: Total minutes of elevated stress
    - Some entries may have only mood data, only sleep/activity data, or combinations. Analyze accordingly.

    # Mood Data:

    {moods}

    # Example Output:

    {{
        "Answer1": "Your mood ratings show a clear positive correlation with activities labeled as "connected" and "active," plus sleep quality plays a crucial role. For example, on May 19, your mood reached a 4 after quality sleep (8.6 hours with good REM), productive tasks for KT's birthday, and a good workout. In contrast, on May 24 when you had only 6.65 hours of sleep and mentioned feeling exhausted, your mood was lower despite productivity. Sleep duration and social engagement appear crucial for boosting your mood.",
        "Answer2": "Looking at your entries for May, your mood generally stayed steady around a rating of 3, with higher peaks at 4 on days marked by active participation and strong social connections, such as May 19 and May 28. Regular exercise, whether in the form of sports or workouts, reliably boosts your mood. However, periods of work-related stress or lack of meaningful interaction tend to prevent your mood from rising higher.",
        "Answer3": "A small win from the past week was on May 28, when you went out for drinks with Craig and played hockey with noticeable enthusiasm, earning a mood rating of 4. This is a great example of how combining social activities and sports can significantly lift your mood. Take a moment to celebrate this win—maintaining these habits is not only enjoyable but also valuable for your emotional well-being.",
        "Answer4": "Based on your recent patterns, you can look forward to more positive moods in the coming week, especially if you maintain your sleep consistency of 8+ hours. Your data shows that good sleep (like the 9+ hour nights you've been having) combined with your regular workouts and social plans consistently leads to mood ratings of 4. Keep prioritizing sleep alongside your active lifestyle, and expect strong, upbeat mood trends to continue."
    }}
    """

    prompt = prompt.format(moods=json.dumps(moods, indent=2), current_date=current_date)

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are an expert mood data analyst. You analyze mood journal entries for trends, patterns, and \
             actionable insights. Your style is concise, supportive, and focused on clarity. When presenting findings, use evidence from the data. \
             Always output JSON only, with no extra text."},
            {"role": "user", "content": prompt}
        ]
    )

    raw_content = getattr(response.choices[0].message, 'content', None)

    # Remove code block markers if present
    if raw_content:
        raw_content = re.sub(r'^```json\s*|^```\s*|```$', '', raw_content.strip(), flags=re.MULTILINE).strip()

    try:
        content = json.loads(raw_content)
        
    except Exception:
        return [{"name": "AI Insights Error", "description": "Could not parse OpenAI response."}]

    return [
        {"name": "Mood Insights", "description": content.get("Answer1", "No answer.")},
        {"name": "Trends and Correlations", "description": content.get("Answer2", "No answer.")},
        {"name": "Small Win of the Week", "description": content.get("Answer3", "No answer.")},
        {"name": "Mood Prediction", "description": content.get("Answer4", "No answer.")}
    ]

def encrypt(text):
    if not text:
        return None
    
    # Convert text to string if it's not already
    if not isinstance(text, str):
        text = json.dumps(text)
    
    # Generate a random 12-byte IV
    iv = os.urandom(12)
    cipher = AES.new(bytes.fromhex(os.getenv('ENCRYPTION_KEY')), AES.MODE_GCM, nonce=iv)
    
    # Encrypt the text
    ciphertext, tag = cipher.encrypt_and_digest(text.encode())
    
    # Return iv:tag:ciphertext format
    return f"{iv.hex()}:{tag.hex()}:{ciphertext.hex()}"

def main():
    users = get_users()
    end_date = datetime.now()
    start_date = end_date - timedelta(days=30)
    
    for user_id, email, email_weekly_summary, ai_insights_enabled in users:
        moods = get_user_moods(user_id, start_date, end_date)
        
        # Skip users with no mood data
        if not moods:
            print(f"Skipping user {user_id} - no mood data found")
            continue
            
        calendar_html = generate_calendar_html(start_date, end_date, moods)
        basic_stats = generate_mood_summary(user_id, start_date, end_date)
        
        # Use ai_insights setting to determine if we should generate AI insights
        if ai_insights_enabled == 1:
            openai_insights = get_openai_insights(moods)
            print(f"Generated AI insights for user {user_id} (ai_insights enabled)")
        else:
            openai_insights = None
            print(f"Skipped AI insights for user {user_id} (ai_insights disabled)")
        
        # Store the summary data in the database
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Encrypt basic_stats and openai_insights before storing
        encrypted_basic_stats = encrypt(basic_stats)
        encrypted_insights = encrypt(openai_insights) if openai_insights else None
        
        # Get today's date in ISO format
        today_date = datetime.now().date().isoformat()
        
        # Check if an entry already exists for today
        cursor.execute("""
            SELECT id FROM summaries 
            WHERE userId = ? AND date = ?
        """, (user_id, today_date))
        
        existing_entry = cursor.fetchone()
        
        if existing_entry:
            # Update existing entry
            cursor.execute("""
                UPDATE summaries 
                SET basic = ?, advanced = ?
                WHERE userId = ? AND date = ?
            """, (encrypted_basic_stats, encrypted_insights, user_id, today_date))
        else:
            # Insert new entry
            cursor.execute("""
                INSERT INTO summaries (userId, date, basic, advanced)
                VALUES (?, ?, ?, ?)
            """, (user_id, today_date, encrypted_basic_stats, encrypted_insights))
        
        conn.commit()
        conn.close()
        
        # Only send email if emailWeeklySummary is enabled
        if email_weekly_summary:
            send_email(email, calendar_html, basic_stats, openai_insights, start_date, end_date, user_id)
        else:
            print(f"Email not sent for user {user_id} as emailWeeklySummary is disabled")

if __name__ == "__main__":
    main()