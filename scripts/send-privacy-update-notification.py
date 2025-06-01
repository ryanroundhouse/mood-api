import sqlite3
from datetime import datetime
from dotenv import load_dotenv
import os
import requests
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import time

# Load environment variables
load_dotenv()

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")

# Database configuration
DB_PATH = "../database.sqlite"

class PrivacyUpdateNotifier:
    def __init__(self):
        self.main_conn = sqlite3.connect(DB_PATH)
        self.sent_count = 0
        self.failed_count = 0

    def __del__(self):
        if hasattr(self, 'main_conn'):
            self.main_conn.close()

    def get_all_verified_users(self):
        """Get all verified users from the database"""
        cursor = self.main_conn.cursor()
        cursor.execute("""
            SELECT id, name, email, accountLevel
            FROM users
            WHERE isVerified = 1
            ORDER BY accountLevel, name
        """)
        return cursor.fetchall()

    def generate_notification_email(self, user_name, account_level):
        """Generate the privacy update notification email HTML"""
        current_date = datetime.now().strftime("%B %d, %Y")
        
        # Determine if user has access to enhanced insights
        has_enhanced_access = account_level in ['pro', 'enterprise']
        
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Important Privacy Policy Update - Moodful</title>
            <style>
                body {{
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 20px;
                    background-color: #f8f9fa;
                    color: #333;
                }}
                .container {{
                    max-width: 700px;
                    margin: 0 auto;
                    background-color: white;
                    border-radius: 10px;
                    box-shadow: 0 0 20px rgba(0,0,0,0.1);
                    overflow: hidden;
                }}
                .header {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 40px;
                    text-align: center;
                }}
                .header h1 {{
                    margin: 0;
                    font-size: 2.2em;
                    font-weight: 300;
                }}
                .header p {{
                    margin: 10px 0 0 0;
                    font-size: 1.1em;
                    opacity: 0.9;
                }}
                .content {{
                    padding: 40px;
                }}
                .greeting {{
                    font-size: 1.1em;
                    margin-bottom: 25px;
                    color: #2c3e50;
                }}
                .update-section {{
                    background: #f8f9fa;
                    border-left: 4px solid #667eea;
                    padding: 25px;
                    margin: 25px 0;
                    border-radius: 0 8px 8px 0;
                }}
                .update-section h3 {{
                    color: #667eea;
                    margin-top: 0;
                    font-size: 1.3em;
                }}
                .feature-highlight {{
                    background: #e6ffe6;
                    border: 2px solid #28a745;
                    padding: 20px;
                    margin: 20px 0;
                    border-radius: 8px;
                }}
                .feature-highlight h4 {{
                    color: #28a745;
                    margin-top: 0;
                }}
                .data-info {{
                    background: #fff3e0;
                    border: 2px solid #ff9800;
                    padding: 20px;
                    margin: 20px 0;
                    border-radius: 8px;
                }}
                .data-info h4 {{
                    color: #f57c00;
                    margin-top: 0;
                }}
                .cta-button {{
                    display: inline-block;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 15px 30px;
                    text-decoration: none;
                    border-radius: 25px;
                    font-weight: bold;
                    margin: 20px 10px 20px 0;
                    transition: transform 0.2s;
                }}
                .cta-button:hover {{
                    transform: translateY(-2px);
                    color: white;
                    text-decoration: none;
                }}
                .secondary-button {{
                    display: inline-block;
                    background: transparent;
                    color: #667eea;
                    border: 2px solid #667eea;
                    padding: 13px 28px;
                    text-decoration: none;
                    border-radius: 25px;
                    font-weight: bold;
                    margin: 20px 10px 20px 0;
                    transition: all 0.2s;
                }}
                .secondary-button:hover {{
                    background: #667eea;
                    color: white;
                    text-decoration: none;
                }}
                .assurance {{
                    background: #e8f5e8;
                    border: 1px solid #28a745;
                    padding: 20px;
                    margin: 25px 0;
                    border-radius: 8px;
                    text-align: center;
                }}
                .assurance strong {{
                    color: #28a745;
                }}
                .footer {{
                    background: #f8f9fa;
                    padding: 30px;
                    text-align: center;
                    color: #6c757d;
                    border-top: 1px solid #dee2e6;
                    font-size: 0.9em;
                }}
                .footer a {{
                    color: #667eea;
                    text-decoration: none;
                }}
                .footer a:hover {{
                    text-decoration: underline;
                }}
                ul {{
                    padding-left: 20px;
                }}
                li {{
                    margin-bottom: 8px;
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🔒 Privacy Policy Update</h1>
                    <p>Important changes to how we protect your data</p>
                </div>
                
                <div class="content">
                    <div class="greeting">
                        Hello {user_name},
                    </div>
                    
                    <p>We're writing to inform you about important updates to our privacy policy that reflect new features and improvements we're making to Moodful. Your privacy remains our top priority, and we want to keep you informed about how we handle your data.</p>
                    
                    <div class="update-section">
                        <h3>📊 What's New</h3>
                        <p>We've made two key changes that enhance your Moodful experience:</p>
                    </div>
        """
        
        # Add account-specific feature information
        if has_enhanced_access:
            html_content += """
                    <div class="feature-highlight">
                        <h4>✨ Enhanced AI Insights Now Available for Basic Users</h4>
                        <p>Great news! We're expanding our AI-powered insights feature to include Basic plan users. As a Pro/Enterprise user, you already have access to these advanced analytics, but now Basic users can opt-in to receive similar AI-powered insights about their mood patterns.</p>
                        <p><strong>What this means for you:</strong> No changes to your current experience. You continue to enjoy all the advanced features you already have.</p>
                    </div>
            """
        else:
            html_content += """
                    <div class="feature-highlight">
                        <h4>✨ New Optional Feature: Enhanced AI Insights</h4>
                        <p>We're excited to offer you the option to access enhanced AI-powered insights about your mood patterns! This optional feature, previously available only to Pro users, can now be enabled by Basic users who want deeper analysis of their mood data.</p>
                        <p><strong>Key points:</strong></p>
                        <ul>
                            <li>This is completely <strong>optional</strong> - you can enable or disable it anytime</li>
                            <li>When enabled, your mood data is securely shared with our AI system for advanced analysis</li>
                            <li>You'll receive personalized insights and pattern recognition</li>
                            <li>All data sharing follows strict security protocols</li>
                        </ul>
                        <p>You can control this feature in your account settings whenever you're ready to explore it.</p>
                    </div>
            """
        
        html_content += """
                    <div class="data-info">
                        <h4>📱 Enhanced Data Collection</h4>
                        <p>To better understand how you interact with Moodful and improve our service, we now collect information about how you submit your mood entries (website, mobile app, or email).</p>
                        <p>This helps us:</p>
                        <ul>
                            <li>Optimize each platform for the best user experience</li>
                            <li>Identify and fix platform-specific issues</li>
                            <li>Develop features that work seamlessly across all platforms</li>
                        </ul>
                    </div>
                    
                    <div class="assurance">
                        <strong>🛡️ Your Privacy Remains Protected</strong><br>
                        These updates don't change our fundamental commitment to protecting your personal information. All data continues to be encrypted, securely stored, and accessible only to authorized personnel who maintain our systems.
                    </div>
                    
                    <p>We believe these changes will enhance your Moodful experience while maintaining the highest standards of data protection. As always, you have full control over your data and can request deletion at any time.</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://moodful.ca/privacy.html" class="cta-button">📋 Read Full Privacy Policy</a>
                        <a href="https://moodful.ca/login.html" class="secondary-button">🔧 Manage Account Settings</a>
                    </div>
                    
                    <p>If you have any questions or concerns about these changes, please don't hesitate to reach out to us. We're here to help and ensure you feel confident about how we protect your data.</p>
                    
                    <p>Thank you for trusting Moodful with your wellness journey.</p>
                    
                    <p style="margin-top: 30px;">
                        Best regards,<br>
                        <strong>The Moodful Team</strong>
                    </p>
                </div>
                
                <div class="footer">
                    <p>This email was sent to inform you of important privacy policy changes.</p>
                    <p>
                        <a href="https://moodful.ca">Moodful.ca</a> | 
                        <a href="https://moodful.ca/contact.html">Contact Us</a> | 
                        <a href="https://moodful.ca/privacy.html">Privacy Policy</a>
                    </p>
                    <p style="margin-top: 15px; font-size: 0.8em; color: #999;">
                        Sent on {current_date} | Moodful Privacy Notification System
                    </p>
                </div>
            </div>
        </body>
        </html>
        """
        
        return html_content

    def send_notification_email(self, user_email, user_name, account_level):
        """Send privacy update notification to a single user"""
        try:
            message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
            
            # Generate email content
            html_content = self.generate_notification_email(user_name, account_level)
            
            # Create multipart message
            msg = MIMEMultipart('alternative')
            msg['From'] = f"Moodful Team <{SENDER_EMAIL}>"
            msg['To'] = user_email
            msg['Subject'] = "🔒 Important Privacy Policy Update - New Features & Data Handling"
            msg['Message-ID'] = message_id
            
            # Add HTML content
            msg_html = MIMEText(html_content, 'html')
            msg.attach(msg_html)
            
            # Send via Mailgun
            response = requests.post(
                f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages.mime",
                auth=("api", MAILGUN_API_KEY),
                data={
                    "to": [user_email],
                },
                files={
                    "message": ("message.mime", msg.as_bytes(), "message/rfc822")
                }
            )
            
            response.raise_for_status()
            self.sent_count += 1
            print(f"✅ Sent to {user_name} ({user_email}) - {account_level}")
            return True
            
        except requests.exceptions.RequestException as e:
            self.failed_count += 1
            print(f"❌ Failed to send to {user_name} ({user_email}): {str(e)}")
            return False

    def send_notifications_to_all_users(self, delay_seconds=2):
        """Send privacy update notifications to all verified users"""
        users = self.get_all_verified_users()
        
        if not users:
            print("⚠️ No verified users found in database")
            return
        
        print(f"📧 Found {len(users)} verified users. Starting email notifications...")
        print(f"⏱️ Using {delay_seconds} second delay between emails to respect rate limits\n")
        
        for i, (user_id, name, email, account_level) in enumerate(users, 1):
            print(f"[{i}/{len(users)}] Processing {name} ({account_level})...")
            
            success = self.send_notification_email(email, name, account_level)
            
            # Add delay between emails to respect rate limits (except for last email)
            if i < len(users) and delay_seconds > 0:
                time.sleep(delay_seconds)
        
        print(f"\n📊 Email notification summary:")
        print(f"   ✅ Successfully sent: {self.sent_count}")
        print(f"   ❌ Failed to send: {self.failed_count}")
        print(f"   📈 Success rate: {(self.sent_count / len(users) * 100):.1f}%")

def main():
    """Main function to send privacy update notifications"""
    print("🔄 Starting Privacy Policy Update Notification Process...")
    print("=" * 60)
    
    # Verify environment variables
    required_vars = ['MAILGUN_API_KEY', 'EMAIL_DOMAIN', 'NOREPLY_EMAIL']
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    
    if missing_vars:
        print(f"❌ Missing required environment variables: {', '.join(missing_vars)}")
        print("Please check your .env file and try again.")
        return
    
    try:
        notifier = PrivacyUpdateNotifier()
        
        # Confirm before sending
        users = notifier.get_all_verified_users()
        print(f"📋 Ready to send privacy update notifications to {len(users)} verified users.")
        
        response = input("Do you want to proceed? (yes/no): ").lower().strip()
        if response != 'yes':
            print("❌ Operation cancelled by user.")
            return
        
        print("\n🚀 Starting email notifications...\n")
        notifier.send_notifications_to_all_users(delay_seconds=2)
        
        print("\n✅ Privacy update notification process completed successfully!")
        
    except Exception as e:
        print(f"❌ Error during notification process: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main() 