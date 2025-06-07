import sqlite3
import requests
import os
import hmac
import hashlib
import base64
import time
import random
import string
from urllib.parse import quote
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

def make_garmin_api_request(endpoint, access_token, token_secret, params=None):
    """Make an authenticated request to the Garmin Wellness API."""
    if not GARMIN_CONSUMER_KEY or not GARMIN_CONSUMER_SECRET:
        raise ValueError("Garmin OAuth credentials not configured")
    
    url = f"{GARMIN_WELLNESS_API_BASE}{endpoint}"
    method = "GET"
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
        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error making API request to {endpoint}: {e}")
        if hasattr(e, 'response') and hasattr(e.response, 'text'):
            print(f"Response: {e.response.text}")
        raise

def test_api_endpoints(access_token, token_secret):
    """Test various Garmin API endpoints to see what data is available."""
    endpoints_to_test = [
        ('/dailies', 'Daily summaries'),
        ('/epochs', 'Epoch summaries'),
        ('/sleeps', 'Sleep summaries'),
        ('/bodyComps', 'Body composition'),
        ('/stressDetails', 'Stress details'),
        ('/userMetrics', 'User metrics'),
        ('/pulseOx', 'Pulse Ox'),
        ('/respiration', 'Respiration')
    ]
    
    # Test with different time windows
    time_windows = [
        (1, "last 24 hours"),
        (3, "last 3 days"),
        (7, "last 7 days")
    ]
    
    results = {}
    
    for endpoint, description in endpoints_to_test:
        print(f"\n--- Testing {description} ({endpoint}) ---")
        results[endpoint] = {}
        
        for days_back, window_desc in time_windows:
            print(f"Trying {window_desc}...")
            
            # Calculate upload window
            end_time = datetime.now()
            start_time = end_time - timedelta(hours=23)  # 23-hour window
            
            start_ts = int(start_time.timestamp())
            end_ts = int(end_time.timestamp())
            
            try:
                data = make_garmin_api_request(
                    endpoint,
                    access_token,
                    token_secret,
                    {
                        'uploadStartTimeInSeconds': start_ts,
                        'uploadEndTimeInSeconds': end_ts
                    }
                )
                
                if data and len(data) > 0:
                    print(f"  ✓ Found {len(data)} records")
                    results[endpoint][window_desc] = len(data)
                    
                    # Show sample data for first record
                    if len(data) > 0:
                        sample = data[0]
                        print(f"  Sample fields: {list(sample.keys())[:5]}...")
                    break  # Found data, no need to try other windows
                else:
                    print(f"  - No data found")
                    results[endpoint][window_desc] = 0
                    
            except Exception as e:
                print(f"  ✗ Error: {e}")
                results[endpoint][window_desc] = "ERROR"
            
            time.sleep(0.5)  # Rate limiting
    
    return results

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

def main():
    """Main function to test Garmin API connectivity."""
    print("Garmin Connect API Connectivity Test")
    print("=" * 80)
    
    # Get connected users
    users = get_garmin_connected_users()
    
    if not users:
        print("No users found with connected Garmin accounts")
        return
    
    user_id, email, access_token, token_secret, garmin_user_id = users[0]
    print(f"Testing with user: {email}")
    print(f"Garmin User ID: {garmin_user_id}")
    
    # Test user ID endpoint first
    print("\n--- Testing User ID endpoint ---")
    try:
        user_id_response = make_garmin_api_request('/user/id', access_token, token_secret)
        print(f"✓ User ID endpoint works: {user_id_response}")
    except Exception as e:
        print(f"✗ User ID endpoint failed: {e}")
        return
    
    # Test various endpoints
    print("\n" + "=" * 80)
    print("Testing Data Endpoints")
    print("=" * 80)
    
    results = test_api_endpoints(access_token, token_secret)
    
    # Summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    
    data_found = False
    for endpoint, window_results in results.items():
        for window, count in window_results.items():
            if isinstance(count, int) and count > 0:
                print(f"✓ {endpoint}: {count} records found in {window}")
                data_found = True
                break
        else:
            print(f"- {endpoint}: No data found")
    
    if not data_found:
        print("\n⚠️  No data found in any endpoint.")
        print("This could mean:")
        print("1. The user hasn't synced their Garmin device recently")
        print("2. Sleep tracking needs to be enabled on the device")
        print("3. The endpoints need to be enabled in Garmin Connect developer portal")
        print("4. The device doesn't support some features (sleep, stress, etc.)")
    else:
        print("\n🎉 API connection working! Some data is available.")

if __name__ == "__main__":
    main() 