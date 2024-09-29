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
nltk.download('opinion_lexicon')
nltk.download('wordnet')
from nltk.corpus import opinion_lexicon
from nltk.corpus import wordnet
from openai import OpenAI

# Load environment variables
load_dotenv()

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")

# Database configuration
DB_PATH = "../database.sqlite"

# OpenAI configuration
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY)

def get_users():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT users.id, users.email, users.accountLevel
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

def send_email(to_email, calendar_html, basic_stats, openai_insights):
    subject = "Your Monthly Mood Calendar"
    
    html_content = f"""
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Monthly Mood Calendar - Moodful</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #6a89cc;">Basic Analytics</h2>
        {basic_stats}
        <h2 style="color: #6a89cc;">Your Monthly Mood Calendar</h2>
        <p>Here's a summary of your mood entries for this month:</p>
        {calendar_html}
    """

    if openai_insights:
        html_content += f"""
        <h2 style="color: #6a89cc;">AI-Generated Insights</h2>
        <h3>Mood Insights</h3>
        <p>{openai_insights['Answer1']}</p>
        <h3>Trends and Correlations</h3>
        <p>{openai_insights['Answer2']}</p>
        <h3>Small Win of the Week</h3>
        <p>{openai_insights['Answer3']}</p>
        <h3>Mood Prediction</h3>
        <p>{openai_insights['Answer4']}</p>
        """

    html_content += """
        <p>Remember, focusing on the positive aspects of your day can help maintain and even improve your mood. Keep up the great work and have a wonderful week ahead!</p>
        <p>Best regards,
        <br/>Your Moodful</p>
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
        datetime_str, rating, comment, activities_str = row
        entry = {
            'datetime': datetime.fromisoformat(datetime_str.replace('Z', '+00:00')),
            'rating': rating,
            'comment': comment,
            'activities': json.loads(activities_str) if activities_str else []
        }
        data.append(entry)

    # Close the database connection
    conn.close()

    # Sort data by datetime
    data.sort(key=lambda x: x['datetime'])

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
        mood_improvement = ((last_week_avg - previous_week_avg) / previous_week_avg) * 100
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
    early_riser_entries = [entry for entry in data if 'woke up early' in entry['comment'].lower()]
    if early_riser_entries:
        early_riser_ratings = [entry['rating'] for entry in early_riser_entries]
        avg_early_riser_mood = sum(early_riser_ratings) / len(early_riser_ratings)
    else:
        avg_early_riser_mood = None

    # 14. Work Satisfaction Influence
    work_related_entries = [entry for entry in data if 'work' in entry['comment'].lower()]
    if work_related_entries:
        work_ratings = [entry['rating'] for entry in work_related_entries]
        avg_work_mood = sum(work_ratings) / len(work_ratings)
    else:
        avg_work_mood = None

    # 15. Family Time Impact
    family_related_entries = [entry for entry in data if any(word in entry['comment'].lower() for word in ['family', 'kid', 'son', 'daughter', 'mom', 'dad', 'father', 'mother'])]
    if family_related_entries:
        family_ratings = [entry['rating'] for entry in family_related_entries]
        avg_family_mood = sum(family_ratings) / len(family_ratings)
    else:
        avg_family_mood = None

    # 16. Progress Towards Goals
    progress_keywords = ['progress', 'built', 'started', 'improvement', 'developed', 'made', 'set up', 'fixed', 'got', 'solved', 'showed', 'effort']
    progress_entries = []
    for entry in data:
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
        comment = entry['comment'].lower()
        words = set(re.findall(r'\b\w+\b', comment))
        stress_word_count += len(words.intersection(stress_words))

    # 18. Positive Outlook Percentage
    positive_days = [entry for entry in data if entry['rating'] >= 3]
    positive_percentage = (len(positive_days) / len(data)) * 100

    # 19. Most Detailed Journal Entry
    most_detailed_entry = max(data, key=lambda x: len(x['comment']))
    most_detailed_day = most_detailed_entry['datetime'].strftime('%A, %B %d, %Y')
    most_detailed_comment = most_detailed_entry['comment']

    # Now, select 4 random statistics
    statistics = []

    def add_statistic(name, description):
        statistics.append({'name': name, 'description': description})

    # Adding statistics
    add_statistic('Average Mood Rating', f'Your average mood rating this week was {average_mood:.2f}.')
    add_statistic('Highest Mood Day', f'On {highest_mood_day}, you had your highest mood rating of {highest_mood_rating}. You mentioned: "{highest_mood_comment}"')
    if mood_improvement is not None:
        add_statistic('Mood Improvement', f'Your mood changed by {mood_improvement:.1f}% compared to the previous week.')
    if most_enjoyed_activity:
        add_statistic('Most Enjoyed Activity', f'You most frequently engaged in "{most_enjoyed_activity}" this week.')
    if boosting_activities:
        add_statistic('Activities Boosting Mood', f'Activities like {", ".join(boosting_activities)} are associated with higher mood ratings.')
    add_statistic('Positive Words Count', f'You used {positive_word_count} positive words in your journal entries this week.')
    if avg_sleep_mood is not None:
        add_statistic('Sleep and Mood Correlation', f'When you had good sleep, your average mood was {avg_sleep_mood:.2f}.')
    if avg_physical_mood is not None:
        add_statistic('Physical Activity Benefits', f'Engaging in physical activities increased your mood to an average of {avg_physical_mood:.2f}.')
    if consistency_percentage is not None:
        add_statistic('Consistency in Tracking', f'You logged your mood on {days_logged} out of {total_days} days ({consistency_percentage:.1f}% consistency).')
    if avg_weekday_mood is not None and avg_weekend_mood is not None:
        add_statistic('Weekend vs. Weekday Mood', f'Your average weekend mood was {avg_weekend_mood:.2f} compared to {avg_weekday_mood:.2f} on weekdays.')
    if avg_early_riser_mood is not None:
        add_statistic('Early Riser Effect', f'On days you woke up early, your average mood was {avg_early_riser_mood:.2f}.')
    if avg_work_mood is not None:
        add_statistic('Work Satisfaction Influence', f'Work-related activities correlated with an average mood of {avg_work_mood:.2f}.')
    if avg_family_mood is not None:
        add_statistic('Family Time Impact', f'Spending time with family increased your mood to an average of {avg_family_mood:.2f}.')
    if avg_progress_mood is not None:
        add_statistic('Progress Towards Goals', f'Making progress on your goals raised your mood to an average of {avg_progress_mood:.2f}.')
    add_statistic('Positive Outlook Percentage', f'{positive_percentage:.1f}% of your days had a mood rating of 3 or higher.')
    add_statistic('Most Detailed Journal Entry', f'Your most detailed entry was on {most_detailed_day}: "{most_detailed_comment}"')

    # Select 4 random statistics
    random_statistics = random.sample(statistics, min(4, len(statistics)))

    # Generate the email body
    email_body = """
    <p>Here's some mood statistics for the period from {start} to {end}:</p>

    """.format(start=start_date.strftime('%B %d, %Y'), end=end_date.strftime('%B %d, %Y'))

    for i, stat in enumerate(random_statistics, start=1):
        email_body += f"<p>{i}. **{stat['name']}**: {stat['description']}\n\n</p>"

    return email_body

def get_openai_insights(moods):
    prompt = """
    Given the sample data, answer some questions for me. Your response must be in json format with 'Answer#' as the key and the answer as the value for that key!
    The 'Answer#' refers to the question number I've asked you to answer. Mood ratings are on a scale from 0-4. Activities could be considered tags or just things of note that took place that day. Comments are freeform text optionally input from the user.
    Phrase the answers as if you're talking to the person who's mood entries are being analyzed.

    Answer1: What are some insights you can find with how the comments, activities, and mood ratings relate to one another.

    Answer2: What are some trends and correlations in the data do you see from the previous month's entries?

    Answer3: What's a small win that happened in the past week? The answer to this question should include encouragement to celebrate that small win.

    Answer4: What's a prediction for the upcoming week you would make for moods (positive prediction only - nothing negative please).

    Sample data:
    {moods}
    """

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[
            {"role": "system", "content": "You are a helpful assistant that analyzes mood data."},
            {"role": "user", "content": prompt.format(moods=json.dumps(moods, indent=2))}
        ]
    )

    return json.loads(response.choices[0].message.content)

def main():
    users = get_users()
    current_date = datetime.now()
    year, month = current_date.year, current_date.month
    end_date = datetime.now()
    start_date = end_date - timedelta(days=30)
    
    for user_id, email, account_level in users:
        moods = get_user_moods(user_id, year, month)
        calendar_html = generate_calendar_html(year, month, moods)
        basic_stats = generate_mood_summary(user_id, start_date, end_date)
        
        if account_level in ['pro', 'enterprise']:
            openai_insights = get_openai_insights(moods)
        else:
            openai_insights = None
        
        send_email(email, calendar_html, basic_stats, openai_insights)

if __name__ == "__main__":
    main()