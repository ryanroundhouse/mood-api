#!/usr/bin/env python3
"""
Generate realistic sleep data for testing purposes.
This script will create sleep summaries for May 7th through June 7th.
"""

import sqlite3
import random
import datetime
import uuid
import pathlib
import os
from dotenv import load_dotenv

# Load environment variables from project root .env file
script_dir = pathlib.Path(__file__).parent.absolute()
project_root = script_dir.parent
dotenv_path = project_root / '.env'
load_dotenv(dotenv_path=dotenv_path)

# Database configuration
DB_PATH = os.path.join(project_root, "database.sqlite")

def generate_summary_id():
    """Generate a realistic Garmin-style summary ID."""
    # Format similar to: x328722b-67777290-6bd0
    part1 = f"x{random.randint(100000, 999999):x}"
    part2 = f"{random.randint(0x10000000, 0xffffffff):x}"
    part3 = f"{random.randint(0x1000, 0xffff):x}"
    return f"{part1}-{part2}-{part3}"

def generate_realistic_sleep_data():
    """Generate realistic sleep duration and stage breakdowns."""
    # Total sleep duration between 6.5 and 9.5 hours
    total_sleep = round(random.uniform(6.5, 9.5), 2)
    
    # Realistic sleep stage percentages (based on sleep research)
    # Deep sleep: 13-23% of total sleep
    # REM sleep: 20-25% of total sleep  
    # Light sleep: 45-55% of total sleep
    # Awake time: 2-8% of total sleep
    
    deep_percentage = random.uniform(0.13, 0.23)
    rem_percentage = random.uniform(0.20, 0.25)
    awake_percentage = random.uniform(0.02, 0.08)
    light_percentage = 1.0 - deep_percentage - rem_percentage - awake_percentage
    
    # Calculate actual hours
    deep_sleep = round(total_sleep * deep_percentage, 2)
    rem_sleep = round(total_sleep * rem_percentage, 2)
    awake_time = round(total_sleep * awake_percentage, 2)
    light_sleep = round(total_sleep * light_percentage, 2)
    
    # Ensure totals add up (adjust light sleep if needed)
    calculated_total = deep_sleep + rem_sleep + awake_time + light_sleep
    if abs(calculated_total - total_sleep) > 0.05:
        light_sleep = round(total_sleep - deep_sleep - rem_sleep - awake_time, 2)
    
    return {
        'duration': total_sleep,
        'deep': max(0, deep_sleep),
        'light': max(0, light_sleep), 
        'rem': max(0, rem_sleep),
        'awake': max(0, awake_time)
    }

def generate_sleep_start_time(date_str):
    """Generate a realistic sleep start time for a given date."""
    # Parse the date
    date = datetime.datetime.strptime(date_str, '%Y-%m-%d')
    
    # Sleep start time typically between 9:30 PM and 1:30 AM
    # For simplicity, let's say between 21:30 and 25:30 (1:30 AM next day)
    start_hour = random.uniform(21.5, 25.5)  # 25.5 = 1:30 AM next day
    
    if start_hour >= 24:
        # Next day
        start_hour -= 24
        date += datetime.timedelta(days=1)
    
    # Convert to minutes
    hour = int(start_hour)
    minute = int((start_hour - hour) * 60)
    
    # Create the sleep start datetime
    sleep_start = date.replace(hour=hour, minute=minute, second=0, microsecond=0)
    
    # Convert to Unix timestamp
    timestamp = int(sleep_start.timestamp())
    
    return timestamp

def insert_sleep_data():
    """Insert realistic sleep data for May 7th through June 7th."""
    
    # Connect to database
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Get user info from existing data
    cursor.execute("SELECT id, garminUserId FROM users WHERE garminConnected = 1 LIMIT 1")
    user_data = cursor.fetchone()
    
    if not user_data:
        print("❌ No connected Garmin user found in database")
        conn.close()
        return
    
    user_id, garmin_user_id = user_data
    print(f"🔍 Found user: ID={user_id}, Garmin ID={garmin_user_id}")
    
    # Generate dates from May 7th to June 7th, 2024
    start_date = datetime.date(2025, 5, 7)
    end_date = datetime.date(2025, 6, 7)
    
    dates_to_generate = []
    current_date = start_date
    while current_date <= end_date:
        dates_to_generate.append(current_date.strftime('%Y-%m-%d'))
        current_date += datetime.timedelta(days=1)
    
    print(f"📅 Generating sleep data for {len(dates_to_generate)} days: {start_date} to {end_date}")
    
    inserted_count = 0
    skipped_count = 0
    
    for date_str in dates_to_generate:
        # Check if data already exists for this date
        cursor.execute(
            "SELECT id FROM sleep_summaries WHERE userId = ? AND calendarDate = ?",
            (user_id, date_str)
        )
        existing = cursor.fetchone()
        
        if existing:
            print(f"⚠️  Sleep data already exists for {date_str}, skipping")
            skipped_count += 1
            continue
        
        # Generate realistic sleep data
        sleep_data = generate_realistic_sleep_data()
        summary_id = generate_summary_id()
        start_time = generate_sleep_start_time(date_str)
        timezone_offset = -18000  # EST/EDT (-5 hours)
        
        # Insert into database
        try:
            cursor.execute("""
                INSERT INTO sleep_summaries (
                    userId, garminUserId, summaryId, calendarDate, startTimeInSeconds,
                    startTimeOffsetInSeconds, durationInHours, deepSleepDurationInHours,
                    lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
                    createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """, (
                user_id,
                garmin_user_id,
                summary_id,
                date_str,
                start_time,
                timezone_offset,
                sleep_data['duration'],
                sleep_data['deep'],
                sleep_data['light'],
                sleep_data['rem'],
                sleep_data['awake']
            ))
            
            print(f"✅ {date_str}: {sleep_data['duration']}h total "
                  f"(Deep: {sleep_data['deep']}h, Light: {sleep_data['light']}h, "
                  f"REM: {sleep_data['rem']}h, Awake: {sleep_data['awake']}h)")
            
            inserted_count += 1
            
        except sqlite3.Error as e:
            print(f"❌ Error inserting data for {date_str}: {e}")
    
    # Commit changes
    conn.commit()
    conn.close()
    
    print(f"\n📊 Summary:")
    print(f"   ✅ Inserted: {inserted_count} records")
    print(f"   ⚠️  Skipped: {skipped_count} records")
    print(f"   📅 Date range: {start_date} to {end_date}")
    
    if inserted_count > 0:
        print(f"\n🎯 Sleep data generated successfully!")
        print(f"   You can now test your scheduled scripts with this realistic sleep data.")

def show_generated_data_sample():
    """Show a sample of the generated data for verification."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT calendarDate, durationInHours, deepSleepDurationInHours, 
               lightSleepDurationInHours, remSleepInHours, awakeDurationInHours
        FROM sleep_summaries 
        WHERE calendarDate BETWEEN '2024-05-07' AND '2024-06-07'
        ORDER BY calendarDate
        LIMIT 10
    """)
    
    results = cursor.fetchall()
    
    if results:
        print(f"\n📋 Sample of generated data (first 10 records):")
        print(f"{'Date':<12} {'Total':<6} {'Deep':<5} {'Light':<6} {'REM':<5} {'Awake':<6}")
        print("-" * 45)
        
        for row in results:
            date, total, deep, light, rem, awake = row
            print(f"{date:<12} {total:<6.2f} {deep:<5.2f} {light:<6.2f} {rem:<5.2f} {awake:<6.2f}")
    
    conn.close()

if __name__ == "__main__":
    print("🌙 Generating realistic sleep data for testing...")
    print("=" * 60)
    
    insert_sleep_data()
    show_generated_data_sample()
    
    print("\n" + "=" * 60)
    print("Sleep data generation completed!") 