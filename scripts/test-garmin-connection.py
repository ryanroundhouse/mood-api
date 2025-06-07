import sqlite3
import os
import pathlib
from dotenv import load_dotenv

# Load environment variables from project root .env file
script_dir = pathlib.Path(__file__).parent.absolute()
project_root = script_dir.parent
dotenv_path = project_root / '.env'
load_dotenv(dotenv_path=dotenv_path)

# Database configuration
DB_PATH = os.path.join(project_root, "database.sqlite")

def check_environment():
    """Check if required environment variables are set."""
    print("Checking environment configuration...")
    print("-" * 50)
    
    garmin_key = os.getenv("GARMIN_CONSUMER_KEY")
    garmin_secret = os.getenv("GARMIN_CONSUMER_SECRET")
    
    if garmin_key:
        print(f"✓ GARMIN_CONSUMER_KEY is set: {garmin_key[:8]}...")
    else:
        print("✗ GARMIN_CONSUMER_KEY is not set")
    
    if garmin_secret:
        print(f"✓ GARMIN_CONSUMER_SECRET is set: {garmin_secret[:8]}...")
    else:
        print("✗ GARMIN_CONSUMER_SECRET is not set")
    
    return bool(garmin_key and garmin_secret)

def check_database():
    """Check database structure and Garmin-connected users."""
    print("\nChecking database structure...")
    print("-" * 50)
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Check if Garmin columns exist
        cursor.execute("PRAGMA table_info(users)")
        columns = [row[1] for row in cursor.fetchall()]
        
        garmin_columns = ['garminAccessToken', 'garminTokenSecret', 'garminUserId', 'garminConnected']
        for col in garmin_columns:
            if col in columns:
                print(f"✓ Column '{col}' exists")
            else:
                print(f"✗ Column '{col}' missing")
        
        # Check for Garmin-connected users
        cursor.execute("""
            SELECT COUNT(*) FROM users 
            WHERE garminConnected = 1 
            AND garminAccessToken IS NOT NULL 
            AND garminTokenSecret IS NOT NULL
        """)
        connected_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM users")
        total_count = cursor.fetchone()[0]
        
        print(f"\nUser Statistics:")
        print(f"Total users: {total_count}")
        print(f"Garmin-connected users: {connected_count}")
        
        if connected_count > 0:
            # Show details of connected users (without sensitive data)
            cursor.execute("""
                SELECT id, email, garminUserId, 
                       CASE WHEN garminAccessToken IS NOT NULL THEN 'SET' ELSE 'NULL' END as token_status
                FROM users 
                WHERE garminConnected = 1 
                AND garminAccessToken IS NOT NULL 
                AND garminTokenSecret IS NOT NULL
            """)
            
            print(f"\nConnected Users:")
            for user in cursor.fetchall():
                user_id, email, garmin_user_id, token_status = user
                print(f"  - ID: {user_id}, Email: {email}")
                print(f"    Garmin ID: {garmin_user_id}")
                print(f"    Token Status: {token_status}")
        
        conn.close()
        return connected_count > 0
        
    except sqlite3.Error as e:
        print(f"✗ Database error: {e}")
        return False

def main():
    """Main function to run all checks."""
    print("Garmin Connect Integration Test")
    print("=" * 80)
    
    # Check environment
    env_ok = check_environment()
    
    # Check database
    db_ok = check_database()
    
    print("\n" + "=" * 80)
    print("Test Results:")
    print(f"Environment Configuration: {'✓ OK' if env_ok else '✗ FAILED'}")
    print(f"Database & Users: {'✓ OK' if db_ok else '✗ FAILED'}")
    
    if env_ok and db_ok:
        print("\n🎉 Ready to fetch Garmin sleep data!")
        print("Run: python scripts/fetch-garmin-sleep.py")
    else:
        print("\n⚠️  Setup incomplete. Please:")
        if not env_ok:
            print("   - Configure GARMIN_CONSUMER_KEY and GARMIN_CONSUMER_SECRET in .env")
        if not db_ok:
            print("   - Ensure users have connected their Garmin accounts")
            print("   - Check database schema has Garmin columns")

if __name__ == "__main__":
    main() 