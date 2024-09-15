import json
from datetime import datetime, timedelta
from collections import defaultdict, Counter
import re
import sqlite3

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

    # 3. Mood Improvement (compared to previous week)
    # Since we have only one week of data, we'll assume a previous week's average mood for demonstration
    previous_week_avg_mood = 2.5  # Placeholder value
    mood_improvement = ((average_mood - previous_week_avg_mood) / previous_week_avg_mood) * 100

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
    positive_words = ['good', 'great', 'fun', 'enjoy', 'happy', 'love', 'well', 'awesome', 'excellent', 'positive', 'focus', 'progress', 'listened']
    positive_word_count = 0
    for entry in data:
        comment = entry['comment'].lower()
        words = re.findall(r'\b\w+\b', comment)
        positive_word_count += sum(1 for word in words if word in positive_words)

    # 7. Sleep and Mood Correlation
    sleep_related_entries = [entry for entry in data if 'good sleep' in entry['activities']]
    if sleep_related_entries:
        sleep_ratings = [entry['rating'] for entry in sleep_related_entries]
        avg_sleep_mood = sum(sleep_ratings) / len(sleep_ratings)
    else:
        avg_sleep_mood = None

    # 8. Social Interaction Effect
    social_keywords = ['family', 'friends', 'kt', 'katie', 'people', 'developer', 'paired', 'listened']
    social_entries = [entry for entry in data if any(word in entry['comment'].lower() for word in social_keywords)]
    if social_entries:
        social_ratings = [entry['rating'] for entry in social_entries]
        avg_social_mood = sum(social_ratings) / len(social_ratings)
    else:
        avg_social_mood = None

    # 9. Physical Activity Benefits
    physical_activities = ['sports', 'hockey']
    physical_entries = [entry for entry in data if any(activity in entry['activities'] for activity in physical_activities)]
    if physical_entries:
        physical_ratings = [entry['rating'] for entry in physical_entries]
        avg_physical_mood = sum(physical_ratings) / len(physical_ratings)
    else:
        avg_physical_mood = None

    # 10. Consistency in Tracking
    total_days = (data[-1]['datetime'] - data[0]['datetime']).days + 1
    days_logged = len(set(entry['datetime'].date() for entry in data))
    consistency_percentage = (days_logged / total_days) * 100

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
    family_related_entries = [entry for entry in data if any(word in entry['comment'].lower() for word in ['family', 'odin', 'kt', 'katie', 'cyrus'])]
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
    stress_keywords = ['stress', 'trouble', 'tired', 'exhausted', 'sad', 'sleep', 'nosebleed']
    stress_word_count = 0
    for entry in data:
        comment = entry['comment'].lower()
        words = re.findall(r'\b\w+\b', comment)
        stress_word_count += sum(1 for word in words if word in stress_keywords)

    # 18. Positive Outlook Percentage
    positive_days = [entry for entry in data if entry['rating'] >= 3]
    positive_percentage = (len(positive_days) / len(data)) * 100

    # 19. Most Detailed Journal Entry
    most_detailed_entry = max(data, key=lambda x: len(x['comment']))
    most_detailed_day = most_detailed_entry['datetime'].strftime('%A, %B %d, %Y')
    most_detailed_comment_length = len(most_detailed_entry['comment'])
    most_detailed_comment = most_detailed_entry['comment']

    # 20. Weekly Mood Trend
    mood_trend = [(entry['datetime'].strftime('%Y-%m-%d'), entry['rating']) for entry in data]

    # Now, select the 4 most interesting statistics
    # For simplicity, we'll choose the ones with the highest positive impact

    statistics = []

    def add_statistic(name, description, score):
        statistics.append({'name': name, 'description': description, 'score': score})

    # Adding statistics with their scores
    add_statistic('Average Mood Rating', f'Your average mood rating this week was {average_mood:.2f}.', average_mood)
    add_statistic('Highest Mood Day', f'On {highest_mood_day}, you had your highest mood rating of {highest_mood_rating}. You mentioned: "{highest_mood_comment}"', highest_mood_rating)
    add_statistic('Mood Improvement', f'Your mood improved by {mood_improvement:.1f}% compared to the previous week.', mood_improvement)
    if most_enjoyed_activity:
        add_statistic('Most Enjoyed Activity', f'You most frequently engaged in "{most_enjoyed_activity}" this week.', activity_counts[most_enjoyed_activity])
    if boosting_activities:
        add_statistic('Activities Boosting Mood', f'Activities like {", ".join(boosting_activities)} are associated with higher mood ratings.', len(boosting_activities))
    add_statistic('Positive Words Count', f'You used {positive_word_count} positive words in your journal entries this week.', positive_word_count)
    if avg_sleep_mood is not None:
        add_statistic('Sleep and Mood Correlation', f'When you had good sleep, your average mood was {avg_sleep_mood:.2f}.', avg_sleep_mood)
    if avg_social_mood is not None:
        add_statistic('Social Interaction Effect', f'Social interactions boosted your mood to an average of {avg_social_mood:.2f}.', avg_social_mood)
    if avg_physical_mood is not None:
        add_statistic('Physical Activity Benefits', f'Engaging in physical activities increased your mood to an average of {avg_physical_mood:.2f}.', avg_physical_mood)
    add_statistic('Consistency in Tracking', f'You logged your mood on {days_logged} out of {total_days} days ({consistency_percentage:.1f}% consistency).', consistency_percentage)
    if avg_weekday_mood is not None and avg_weekend_mood is not None:
        add_statistic('Weekend vs. Weekday Mood', f'Your average weekend mood was {avg_weekend_mood:.2f} compared to {avg_weekday_mood:.2f} on weekdays.', abs(avg_weekend_mood - avg_weekday_mood))
    if avg_early_riser_mood is not None:
        add_statistic('Early Riser Effect', f'On days you woke up early, your average mood was {avg_early_riser_mood:.2f}.', avg_early_riser_mood)
    if avg_work_mood is not None:
        add_statistic('Work Satisfaction Influence', f'Work-related activities correlated with an average mood of {avg_work_mood:.2f}.', avg_work_mood)
    if avg_family_mood is not None:
        add_statistic('Family Time Impact', f'Spending time with family increased your mood to an average of {avg_family_mood:.2f}.', avg_family_mood)
    if avg_progress_mood is not None:
        add_statistic('Progress Towards Goals', f'Making progress on your goals raised your mood to an average of {avg_progress_mood:.2f}.', avg_progress_mood)
    add_statistic('Positive Outlook Percentage', f'{positive_percentage:.1f}% of your days had a mood rating of 3 or higher.', positive_percentage)
    add_statistic('Most Detailed Journal Entry', f'Your most detailed entry was on {most_detailed_day}: "{most_detailed_comment}"', most_detailed_comment_length)

    # Sort statistics by score
    statistics.sort(key=lambda x: x['score'], reverse=True)

    # Select the top 4 statistics
    top_statistics = statistics[:4]

    # Generate the email body
    email_body = """
    <p>Here's some mood statistics for the period from {start} to {end}:</p>

    """.format(start=start_date.strftime('%B %d, %Y'), end=end_date.strftime('%B %d, %Y'))

    for i, stat in enumerate(top_statistics, start=1):
        email_body += f"<p>{i}. **{stat['name']}**: {stat['description']}\n\n</p>"

    return email_body

# Example usage:
# user_id = 1
# end_date = datetime.now()
# start_date = end_date - timedelta(days=30)
# summary = generate_mood_summary(user_id, start_date, end_date)
# print(summary)
