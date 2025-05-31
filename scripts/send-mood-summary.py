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
        SELECT users.id, users.email, users.accountLevel, user_settings.emailWeeklySummary
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

def get_user_moods(user_id, year, month):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    start_date = datetime(year, month, 1)
    end_date = start_date + timedelta(days=32)
    end_date = end_date.replace(day=1)

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
        day = dt.strftime('%d')
        # Decrypt the comment
        decrypted_comment = decrypt(row[2]) if row[2] else None
        moods[day] = {
            'date': dt.strftime('%Y-%m-%d'),
            'rating': row[1], 
            'comment': decrypted_comment, 
            'activities': json.loads(row[3]) if row[3] else []
        }
    
    conn.close()
    return moods

def generate_calendar_html(year, month, moods):
    calendar.setfirstweekday(calendar.SUNDAY)  # Set the first day of the week to Sunday
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

def send_email(to_email, calendar_html, basic_stats, openai_insights, start_date, end_date, user_id):
    subject = "Moodful - Your Weekly Mood Summary"
    
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
        <title>Monthly Mood Calendar - Moodful</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #6a89cc;">Basic Analytics</h2>
        {email_body}
        <h2 style="color: #6a89cc;">Your Monthly Mood Calendar</h2>
        <p>Here's a summary of your mood entries for this month:</p>
        {calendar_html}
    """

    if openai_insights:
        html_content += f"""
        <h2 style="color: #6a89cc;">AI-Generated Insights</h2>
        """
        for insight in openai_insights:
            html_content += f"""
            <h3>{insight['name']}</h3>
            <p>{insight['description']}</p>
            """

    html_content += f"""
        <p>Remember, focusing on the positive aspects of your day can help maintain and even improve your mood. Keep up the great work and have a wonderful week ahead!</p>
        <p>Best regards,
        <br/>Your Moodful</p>
        <div style="margin-top: 30px; font-size: 0.9em; color: #888; border-top: 1px solid #ddd; padding-top: 15px;">
            <p>If you no longer wish to receive weekly summary emails, you can <a href="{unsubscribe_link}">unsubscribe from weekly summaries</a>.</p>
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
    # Database configuration
    DB_PATH = "../database.sqlite"

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

    # 7. Sleep and Mood Correlation
    sleep_related_entries = [entry for entry in data if 'good sleep' in entry['activities']]
    if sleep_related_entries:
        sleep_ratings = [entry['rating'] for entry in sleep_related_entries]
        avg_sleep_mood = sum(sleep_ratings) / len(sleep_ratings)
    else:
        avg_sleep_mood = None

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

    You will be given mood data in JSON format for the previous month. For each question below, provide a concise answer in JSON format, using 'Answer#' as the key.

    **Instructions:**

    - ALL answers should be roughly 50 to 80 words.
    - Answers must be clear, concise, and supported by specific examples or evidence from the data.
    - Do not repeat the questions.
    - Only output JSON, no extra text or explanation.
    - For each answer, reference at least one relevant date and activity/comment from the sample data.
    - For predictions, only give positive predictions based on trends you observe.
    - For 'small win', it must be a positive event from the last 7 days, with encouragement to celebrate it.
    - For 'prediction', it must be a positive prediction for the upcoming week, based on recent patterns.
    - For 'insights', it must be a concise summary of the insights you can find about how comments, activities, and mood ratings relate to one another.
    - For 'trends', it must be a concise summary of the most significant trends or correlations in the data from the past month.

    **Questions:**

    1. What insights can you find about how comments, activities, and mood ratings relate to one another?
    2. What are the most significant trends or correlations in the data from the past month?
    3. Identify a small win from the past week. Include encouragement to celebrate this.
    4. Predict one positive thing that might happen with your moods next week, based on recent patterns.

    **Details:**
    - Mood ratings are on a scale from 0-4 where 0 is the worst mood and 4 is the best mood.
    - Activities are tags for activities, aspects, observations, etc. that the user can associate with mood entries outside of their comment.
    - Comments are freeform text optionally input by the user about their day.

    # Mood Data:

    {moods}

    # Example Output:

    {{
        "Answer1": "Your mood ratings show a clear positive correlation with activities labeled as “connected” and “active.” For example, on May 19, your mood reached a 4 after a day full of productive tasks for KT’s birthday and a good workout. In contrast, on days like May 15, when work was stressful and there was less social interaction, your mood was lower. Social engagement and physical activity appear crucial for boosting your mood.",
        "Answer2": "Looking at your entries for May, your mood generally stayed steady around a rating of 3, with higher peaks at 4 on days marked by active participation and strong social connections, such as May 19 and May 28. Regular exercise, whether in the form of sports or workouts, reliably boosts your mood. However, periods of work-related stress or lack of meaningful interaction tend to prevent your mood from rising higher.",
        "Answer3": "A small win from the past week was on May 28, when you went out for drinks with Craig and played hockey with noticeable enthusiasm, earning a mood rating of 4. This is a great example of how combining social activities and sports can significantly lift your mood. Take a moment to celebrate this win—maintaining these habits is not only enjoyable but also valuable for your emotional well-being.",
        "Answer4": "Based on your recent habits, you can look forward to more positive moods in the coming week, especially if you continue prioritizing workouts and time spent with friends or family. Participating in hockey, staying active, and keeping up with social plans are likely to lead to more days rated at 4. Stay consistent with these routines and expect a strong, upbeat mood trend to continue."
    }}
    """

    prompt = prompt.format(moods=json.dumps(moods, indent=2), current_date=current_date)
    
    print("Sending prompt to OpenAI:")
    print(prompt)

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

        print("OpenAI Response:")
        print(content)
        
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
    current_date = datetime.now()
    year, month = current_date.year, current_date.month
    end_date = datetime.now()
    start_date = end_date - timedelta(days=30)
    
    for user_id, email, account_level, email_weekly_summary in users:
        moods = get_user_moods(user_id, year, month)
        
        # Skip users with no mood data
        if not moods:
            print(f"Skipping user {user_id} - no mood data found")
            continue
            
        calendar_html = generate_calendar_html(year, month, moods)
        basic_stats = generate_mood_summary(user_id, start_date, end_date)
        
        if account_level in ['pro', 'enterprise']:
            openai_insights = get_openai_insights(moods)
        else:
            openai_insights = None
        
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