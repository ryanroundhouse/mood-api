import sqlite3
import requests
import os
import hmac
import hashlib
import base64
import time
import random
import string
from urllib.parse import urlencode, quote
from datetime import datetime, timedelta
import pathlib
import json
from dotenv import load_dotenv

# Load environment variables from project root .env file
script_dir = pathlib.Path(__file__).parent.absolute()
project_root = script_dir.parent
dotenv_path = project_root / '.env'
load_dotenv(dotenv_path=dotenv_path)

# Garmin OAuth configuration
GARMIN_CONSUMER_KEY = os.getenv("GARMIN_CONSUMER_KEY")
GARMIN_CONSUMER_SECRET = os.getenv("GARMIN_CONSUMER_SECRET")
GARMIN_WELLNESS_API_BASE = "https://apis.garmin.com/wellness-api/rest"

# Database configuration
DB_PATH = os.path.join(project_root, "database.sqlite")

def generate_nonce(length=32):
    """Generate a random nonce for OAuth requests."""
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

def percent_encode(string):
    """Percent encode string according to OAuth specification."""
    return quote(str(string), safe='')

def normalize_parameters(params):
    """Normalize parameters for OAuth signature base string."""
    encoded_params = []
    for key, value in sorted(params.items()):
        encoded_params.append(f"{percent_encode(key)}={percent_encode(value)}")
    return "&".join(encoded_params)

def create_signature_base_string(method, url, params):
    """Create the signature base string for OAuth."""
    normalized_params = normalize_parameters(params)
    return f"{method}&{percent_encode(url)}&{percent_encode(normalized_params)}"

def create_oauth_signature(method, url, params, consumer_secret, token_secret=""):
    """Create OAuth signature using HMAC-SHA1."""
    base_string = create_signature_base_string(method, url, params)
    signing_key = f"{percent_encode(consumer_secret)}&{percent_encode(token_secret)}"
    
    signature = hmac.new(
        signing_key.encode('utf-8'),
        base_string.encode('utf-8'),
        hashlib.sha1
    ).digest()
    
    return base64.b64encode(signature).decode('utf-8')

def create_authorization_header(oauth_params):
    """Create the OAuth authorization header."""
    auth_params = []
    for key, value in sorted(oauth_params.items()):
        auth_params.append(f'{key}="{percent_encode(value)}"')
    return f"OAuth {', '.join(auth_params)}"

def make_garmin_api_request(endpoint, access_token, token_secret, params=None, method="GET"):
    """Make an authenticated request to the Garmin Wellness API."""
    if not GARMIN_CONSUMER_KEY or not GARMIN_CONSUMER_SECRET:
        raise ValueError("Garmin OAuth credentials not configured")
    
    url = f"{GARMIN_WELLNESS_API_BASE}{endpoint}"
    timestamp = str(int(time.time()))
    nonce = generate_nonce()
    
    # OAuth parameters
    oauth_params = {
        'oauth_consumer_key': GARMIN_CONSUMER_KEY,
        'oauth_token': access_token,
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': timestamp,
        'oauth_nonce': nonce,
        'oauth_version': '1.0'
    }
    
    # Add query parameters to OAuth params for signature
    all_params = oauth_params.copy()
    if params:
        all_params.update(params)
    
    # Create signature
    signature = create_oauth_signature(method, url, all_params, GARMIN_CONSUMER_SECRET, token_secret)
    oauth_params['oauth_signature'] = signature
    
    # Create authorization header
    auth_header = create_authorization_header(oauth_params)
    
    # Make request
    headers = {
        'Authorization': auth_header,
        'Content-Type': 'application/json'
    }
    
    try:
        if method == "GET":
            response = requests.get(url, headers=headers, params=params, timeout=30)
        else:
            response = requests.request(method, url, headers=headers, params=params, timeout=30)
        
        response.raise_for_status()
        
        # Some endpoints return empty responses with 202 status (like backfill)
        if response.status_code == 202:
            return {"status": "accepted", "message": "Backfill request submitted"}
        
        # Try to parse JSON, but handle empty responses
        try:
            return response.json()
        except ValueError:
            return {"status": "success", "message": "Request completed"}
            
    except requests.exceptions.RequestException as e:
        print(f"Error making Garmin API request: {e}")
        if hasattr(e, 'response') and hasattr(e.response, 'text'):
            print(f"Response: {e.response.text}")
        raise

def get_garmin_connected_users():
    """Get all users who have connected their Garmin accounts."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT id, email, garminAccessToken, garminTokenSecret, garminUserId
        FROM users 
        WHERE garminConnected = 1 
        AND garminAccessToken IS NOT NULL 
        AND garminTokenSecret IS NOT NULL
    """)
    
    users = cursor.fetchall()
    conn.close()
    return users

def request_sleep_backfill_for_dates(access_token, token_secret, start_date, end_date):
    """Request sleep data backfill from Garmin Health API for specific date range."""
    print(f"Requesting sleep data backfill from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}...")
    
    # Convert to Unix timestamps
    start_ts = int(start_date.timestamp())
    end_ts = int(end_date.timestamp())
    
    print(f"Sleep data range: {start_date.strftime('%Y-%m-%d %H:%M')} to {end_date.strftime('%Y-%m-%d %H:%M')}")
    print(f"Unix timestamps: {start_ts} to {end_ts}")
    
    # Calculate total days
    total_days = (end_date - start_date).days
    
    # Split into 90-day chunks if necessary (API limit)
    max_days_per_request = 90
    chunks = []
    
    if total_days <= max_days_per_request:
        chunks.append((start_ts, end_ts))
    else:
        current_start = start_ts
        while current_start < end_ts:
            chunk_end = min(current_start + (max_days_per_request * 24 * 3600), end_ts)
            chunks.append((current_start, chunk_end))
            current_start = chunk_end
    
    print(f"Will make {len(chunks)} backfill request(s)")
    
    successful_requests = 0
    
    for i, (chunk_start, chunk_end) in enumerate(chunks, 1):
        chunk_start_date = datetime.fromtimestamp(chunk_start).strftime('%Y-%m-%d')
        chunk_end_date = datetime.fromtimestamp(chunk_end).strftime('%Y-%m-%d')
        
        print(f"\nBackfill request {i}/{len(chunks)}: {chunk_start_date} to {chunk_end_date}")
        
        try:
            response = make_garmin_api_request(
                '/backfill/sleeps',
                access_token,
                token_secret,
                {
                    'summaryStartTimeInSeconds': str(chunk_start),
                    'summaryEndTimeInSeconds': str(chunk_end)
                },
                method='GET'
            )
            
            if response.get('status') == 'accepted':
                print(f"✓ Backfill request {i} submitted successfully")
                successful_requests += 1
            else:
                print(f"✓ Backfill request {i} completed: {response}")
                successful_requests += 1
                
        except Exception as e:
            print(f"✗ Error with backfill request {i}: {e}")
            continue
        
        # Add delay between requests to avoid rate limiting
        if i < len(chunks):
            print("Waiting 2 seconds before next request...")
            time.sleep(2)
    
    return successful_requests, len(chunks)

def request_backfill_for_specific_dates(user_id, email, access_token, token_secret, garmin_user_id, start_date, end_date):
    """Request sleep backfill for a specific user and date range."""
    print(f"\n=== Requesting sleep backfill for user: {email} (Garmin ID: {garmin_user_id}) ===")
    
    try:
        successful, total = request_sleep_backfill_for_dates(access_token, token_secret, start_date, end_date)
        
        if successful == total:
            print(f"✓ All {successful} backfill requests submitted successfully")
            print("🔄 Garmin will now process the backfill requests asynchronously")
            print("📨 Sleep data will be sent to your configured webhook endpoint when ready")
            print("   Check your webhook endpoint console logs for incoming data")
        else:
            print(f"⚠️  {successful}/{total} backfill requests successful")
        
        return successful > 0
        
    except Exception as e:
        print(f"✗ Error requesting backfill for user {email}: {e}")
        return False

def main():
    """Main function to request Garmin sleep data backfill for all connected users."""
    print("Requesting Garmin Connect sleep data backfill for connected users...")
    print("=" * 80)
    
    # Configuration - Request February 2024 sleep data
    # Set specific date range instead of "last X days"
    start_date = datetime(2025, 5, 29)
    end_date = datetime(2025, 5, 30)
    
    print(f"Requesting sleep data from {start_date.strftime('%B %d, %Y')} to {end_date.strftime('%B %d, %Y')}")
    
    # Get all users with Garmin connections
    users = get_garmin_connected_users()
    
    if not users:
        print("No users found with connected Garmin accounts")
        print("\nTo use this script:")
        print("1. Users must connect their Garmin accounts through your app")
        print("2. Configure your webhook endpoint in Garmin's Endpoint Configuration Tool")
        print("3. Enable sleep summaries in your Garmin Health API configuration")
        return
    
    print(f"Found {len(users)} users with connected Garmin accounts")
    print()
    
    successful_users = 0
    
    # Request backfill for each user
    for user_id, email, access_token, token_secret, garmin_user_id in users:
        try:
            success = request_backfill_for_specific_dates(
                user_id, email, access_token, token_secret, garmin_user_id, start_date, end_date
            )
            if success:
                successful_users += 1
        except Exception as e:
            print(f"Failed to request backfill for user {email}: {e}")
            continue
    
    print("\n" + "=" * 80)
    print(f"Sleep backfill requests completed for {successful_users}/{len(users)} users")
    print()
    print("IMPORTANT NOTES:")
    print("• Backfill requests are processed asynchronously by Garmin")
    print("• Sleep data will be sent to your webhook endpoint when ready")
    print("• This may take several minutes to hours depending on data volume")
    print("• Make sure your webhook endpoint is configured and accessible:")
    print("  - URL: https://yourdomain.com/api/garmin/sleep-webhook")
    print("  - Method: POST")
    print("  - Enabled in Garmin Endpoint Configuration Tool")
    print("• Check your application logs for incoming webhook notifications")

if __name__ == "__main__":
    main() 