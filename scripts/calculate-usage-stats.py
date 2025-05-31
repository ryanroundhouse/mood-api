import sqlite3
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
import requests
import uuid
import json
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
import pandas as pd
from collections import defaultdict, Counter
import base64
import io
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart

# Load environment variables
load_dotenv()

# Email configuration
MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY")
MAILGUN_DOMAIN = os.getenv("EMAIL_DOMAIN")
SENDER_EMAIL = os.getenv("NOREPLY_EMAIL")
RECIPIENT_EMAIL = "ryan@moodful.ca"

# Database configuration
DB_PATH = "../database.sqlite"
ANALYTICS_DB_PATH = "../analytics.sqlite"

class MoodfulAnalytics:
    def __init__(self):
        self.main_conn = sqlite3.connect(DB_PATH)
        self.analytics_conn = sqlite3.connect(ANALYTICS_DB_PATH)
        self.date_ranges = self.get_date_ranges()
        self.chart_files = {}  # Track chart files for email attachments

    def __del__(self):
        if hasattr(self, 'main_conn'):
            self.main_conn.close()
        if hasattr(self, 'analytics_conn'):
            self.analytics_conn.close()
        # Clean up any chart files
        for filepath in getattr(self, 'chart_files', {}).values():
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except:
                    pass

    def get_date_ranges(self):
        """Generate commonly used date ranges for analysis - all ranges exclude the current day"""
        now = datetime.now()
        today = now.date()
        
        return {
            'yesterday': (today - timedelta(days=1), today),
            'past_7_days': (today - timedelta(days=7), today),
            'past_30_days': (today - timedelta(days=30), today),
            'past_90_days': (today - timedelta(days=90), today),
            'current_month': (today.replace(day=1), today),
            'previous_month': self.get_previous_month_range(today)
        }

    def get_previous_month_range(self, current_date):
        """Get the date range for the previous month"""
        first_day_current_month = current_date.replace(day=1)
        last_day_previous_month = first_day_current_month - timedelta(days=1)
        first_day_previous_month = last_day_previous_month.replace(day=1)
        return (first_day_previous_month, first_day_current_month)

    def create_chart_references(self, fig, chart_id, width=800, height=400):
        """Create both base64 and file references for a chart"""
        try:
            img_bytes = fig.to_image(format="png", width=width, height=height)
            
            # Create base64 for local HTML
            img_base64 = base64.b64encode(img_bytes).decode()
            base64_src = f"data:image/png;base64,{img_base64}"
            
            # Save file for email attachment
            filename = f"chart_{chart_id}_{uuid.uuid4().hex[:8]}.png"
            with open(filename, 'wb') as f:
                f.write(img_bytes)
            
            # Store file reference for email
            self.chart_files[chart_id] = filename
            
            return {
                'base64': base64_src,
                'cid': f"cid:{chart_id}",
                'filename': filename
            }
        except Exception as e:
            print(f"Warning: Could not generate chart {chart_id}: {e}")
            return {
                'base64': None,
                'cid': None,
                'filename': None
            }

    def get_user_metrics(self):
        """Get comprehensive user metrics"""
        cursor = self.main_conn.cursor()
        
        # Total user counts by account level
        cursor.execute("""
            SELECT accountLevel, COUNT(*) as count
            FROM users
            WHERE isVerified = 1
            GROUP BY accountLevel
        """)
        
        user_counts = {'basic': 0, 'pro': 0, 'enterprise': 0}
        for level, count in cursor.fetchall():
            if level in user_counts:
                user_counts[level] = count
        
        # Create user distribution pie chart
        fig_users = go.Figure(data=[go.Pie(
            labels=list(user_counts.keys()),
            values=list(user_counts.values()),
            hole=0.4,
            textinfo='label+percent+value',
            textfont_size=12,
            marker_colors=['#3498db', '#e74c3c', '#f39c12']
        )])
        fig_users.update_layout(
            title="User Distribution by Account Level",
            font=dict(size=14),
            showlegend=True,
            margin=dict(t=60, b=40, l=40, r=40)
        )
        
        return {
            'user_counts': user_counts,
            'total_users': sum(user_counts.values()),
            'charts': {
                'user_distribution': self.create_chart_references(fig_users, 'user_distribution'),
            }
        }

    def get_engagement_metrics(self):
        """Get detailed engagement metrics from analytics database with week-over-week platform analysis"""
        cursor = self.analytics_conn.cursor()
        
        # Check if analytics table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mood_submissions'")
        if not cursor.fetchone():
            return {'error': 'Analytics table not found'}
        
        # Calculate date ranges for current week and previous week
        today = datetime.now().date()
        # Find the most recent Sunday (start of current week)
        days_since_sunday = today.weekday() + 1 if today.weekday() != 6 else 0
        current_week_start = today - timedelta(days=days_since_sunday)
        current_week_end = today  # Exclude current day to reflect completed days only
        
        # Previous week
        previous_week_start = current_week_start - timedelta(days=7)
        previous_week_end = current_week_start
        
        def get_platform_stats_for_period(start_date, end_date):
            """Get platform usage stats for a specific period"""
            cursor.execute("""
                SELECT source, 
                       COUNT(*) as submission_count,
                       COUNT(DISTINCT user_id) as unique_users
                FROM mood_submissions
                WHERE DATE(submission_datetime) >= ? AND DATE(submission_datetime) < ?
                GROUP BY source
                ORDER BY submission_count DESC
            """, (start_date.isoformat(), end_date.isoformat()))
            
            platform_data = {}
            for row in cursor.fetchall():
                source, count, users = row
                platform_data[source] = {
                    'submission_count': count,
                    'unique_users': users
                }
            return platform_data
        
        # Get platform stats for different periods
        current_week_platforms = get_platform_stats_for_period(current_week_start, current_week_end)
        previous_week_platforms = get_platform_stats_for_period(previous_week_start, previous_week_end)
        
        # Get all-time platform stats
        cursor.execute("""
            SELECT source, 
                   COUNT(*) as submission_count,
                   COUNT(DISTINCT user_id) as unique_users,
                   AVG(comment_length) as avg_comment_length,
                   AVG(total_tags) as avg_tags_per_submission
            FROM mood_submissions
            GROUP BY source
            ORDER BY submission_count DESC
        """)
        
        all_time_platforms = {}
        for row in cursor.fetchall():
            source, count, users, avg_comment, avg_tags = row
            all_time_platforms[source] = {
                'submission_count': count,
                'unique_users': users,
                'avg_comment_length': round(avg_comment or 0, 2),
                'avg_tags_per_submission': round(avg_tags or 0, 2)
            }
        
        # Get all unique platforms
        all_platforms = set()
        all_platforms.update(current_week_platforms.keys())
        all_platforms.update(previous_week_platforms.keys())
        all_platforms.update(all_time_platforms.keys())
        
        # Normalize data - ensure all platforms exist in all periods
        def normalize_platform_data(platform_data, platform_list):
            normalized = {}
            for platform in platform_list:
                if platform in platform_data:
                    normalized[platform] = platform_data[platform]
                else:
                    normalized[platform] = {'submission_count': 0, 'unique_users': 0}
            return normalized
        
        current_week_platforms = normalize_platform_data(current_week_platforms, all_platforms)
        previous_week_platforms = normalize_platform_data(previous_week_platforms, all_platforms)
        
        # Calculate changes for each platform
        def calculate_platform_change(current, previous):
            """Calculate absolute and percentage change for platform metrics"""
            absolute_change = current - previous
            if previous == 0:
                percentage_change = 0 if current == 0 else 100
            else:
                percentage_change = round((absolute_change / previous) * 100, 1)
            return {
                'absolute': absolute_change,
                'percentage': percentage_change
            }
        
        platform_changes = {}
        for platform in all_platforms:
            current_count = current_week_platforms[platform]['submission_count']
            previous_count = previous_week_platforms[platform]['submission_count']
            platform_changes[platform] = calculate_platform_change(current_count, previous_count)
        
        # Create grouped bar chart showing current week vs previous week
        platform_names = [platform.title() for platform in all_platforms]
        current_week_data = [current_week_platforms[platform]['submission_count'] for platform in all_platforms]
        previous_week_data = [previous_week_platforms[platform]['submission_count'] for platform in all_platforms]
        
        # Only create chart if we have data
        if any(current_week_data) or any(previous_week_data):
            fig_platform = go.Figure()
            
            # Add bars for each time period
            fig_platform.add_trace(go.Bar(
                name='Current Week',
                x=platform_names,
                y=current_week_data,
                marker_color='#3498db',
                text=current_week_data,
                textposition='auto'
            ))
            
            fig_platform.add_trace(go.Bar(
                name='Previous Week',
                x=platform_names,
                y=previous_week_data,
                marker_color='#95a5a6',
                text=previous_week_data,
                textposition='auto'
            ))
            
            fig_platform.update_layout(
                title="Platform Usage Comparison (Current vs Previous Week)",
                yaxis_title="Number of Submissions",
                xaxis_title="Platform",
                font=dict(size=12),
                margin=dict(t=60, b=40, l=40, r=40),
                barmode='group',  # Group bars side by side
                legend=dict(
                    orientation="h",
                    yanchor="bottom",
                    y=1.02,
                    xanchor="right",
                    x=1
                )
            )
            
            platform_chart = self.create_chart_references(fig_platform, 'platform_usage')
        else:
            platform_chart = None
        
        # Submission volume by time period (keep existing functionality)
        volume_stats = {}
        for period, (start_date, end_date) in self.date_ranges.items():
            cursor.execute("""
                SELECT COUNT(*) as total_submissions,
                       COUNT(DISTINCT user_id) as unique_users
                FROM mood_submissions 
                WHERE DATE(submission_datetime) >= ? AND DATE(submission_datetime) < ?
            """, (start_date.isoformat(), end_date.isoformat()))
            
            result = cursor.fetchone()
            volume_stats[period] = {
                'total_submissions': result[0],
                'unique_users': result[1],
                'avg_submissions_per_user': result[0] / result[1] if result[1] > 0 else 0
            }
        
        # Daily activity trend (last 30 days)
        start_date = self.date_ranges['past_30_days'][0]
        cursor.execute("""
            SELECT DATE(submission_datetime) as date, 
                   COUNT(*) as submissions,
                   COUNT(DISTINCT user_id) as active_users
            FROM mood_submissions
            WHERE DATE(submission_datetime) >= ?
            GROUP BY DATE(submission_datetime)
            ORDER BY date
        """, (start_date.isoformat(),))
        
        daily_data = cursor.fetchall()
        
        # Create daily activity chart
        if daily_data:
            dates, submissions, users = zip(*daily_data)
            fig_daily = make_subplots(specs=[[{"secondary_y": True}]])
            
            fig_daily.add_trace(
                go.Scatter(x=dates, y=submissions, name="Submissions", line=dict(color='#3498db')),
                secondary_y=False,
            )
            
            fig_daily.add_trace(
                go.Scatter(x=dates, y=users, name="Active Users", line=dict(color='#e74c3c')),
                secondary_y=True,
            )
            
            fig_daily.update_xaxes(title_text="Date")
            fig_daily.update_yaxes(title_text="Submissions", secondary_y=False)
            fig_daily.update_yaxes(title_text="Active Users", secondary_y=True)
            fig_daily.update_layout(
                title_text="Daily Activity Trend (Last 30 Days)",
                font=dict(size=12),
                margin=dict(t=60, b=40, l=40, r=40)
            )
            
            daily_chart = self.create_chart_references(fig_daily, 'daily_activity', width=900)
        else:
            daily_chart = None
        
        return {
            'volume_stats': volume_stats,
            'current_week_platforms': current_week_platforms,
            'previous_week_platforms': previous_week_platforms,
            'all_time_platforms': all_time_platforms,
            'platform_changes': platform_changes,
            'date_ranges': {
                'current_week': f"{current_week_start.strftime('%m/%d')} - {(today - timedelta(days=1)).strftime('%m/%d')}",
                'previous_week': f"{previous_week_start.strftime('%m/%d')} - {(previous_week_end - timedelta(days=1)).strftime('%m/%d')}"
            },
            'daily_data': daily_data,
            'charts': {
                'platform_usage': platform_chart,
                'daily_activity': daily_chart
            }
        }

    def get_content_quality_metrics(self):
        """Analyze content quality and user behavior with week-over-week comparison"""
        cursor = self.analytics_conn.cursor()
        
        # Check if analytics table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mood_submissions'")
        if not cursor.fetchone():
            return {'error': 'Analytics table not found'}
        
        # Calculate date ranges for current week and previous week
        today = datetime.now().date()
        # Find the most recent Sunday (start of current week)
        days_since_sunday = today.weekday() + 1 if today.weekday() != 6 else 0
        current_week_start = today - timedelta(days=days_since_sunday)
        current_week_end = today  # Exclude current day to reflect completed days only
        
        # Previous week
        previous_week_start = current_week_start - timedelta(days=7)
        previous_week_end = current_week_start
        
        def get_week_quality_stats(start_date, end_date):
            """Get content quality stats for a specific week"""
            cursor.execute("""
                SELECT AVG(comment_length) as avg_comment_length,
                       AVG(total_tags) as avg_total_tags,
                       AVG(custom_tags_count) as avg_custom_tags,
                       COUNT(*) as total_submissions,
                       SUM(CASE WHEN comment_length > 0 THEN 1 ELSE 0 END) as submissions_with_comments,
                       SUM(CASE WHEN total_tags > 0 THEN 1 ELSE 0 END) as submissions_with_tags,
                       SUM(CASE WHEN custom_tags_count > 0 THEN 1 ELSE 0 END) as submissions_with_custom_tags
                FROM mood_submissions
                WHERE DATE(submission_datetime) >= ? AND DATE(submission_datetime) < ?
            """, (start_date.isoformat(), end_date.isoformat()))
            
            result = cursor.fetchone()
            if result and result[3] > 0:  # total_submissions > 0
                avg_comment, avg_tags, avg_custom, total, with_comments, with_tags, with_custom = result
                return {
                    'avg_comment_length': round(avg_comment or 0, 2),
                    'avg_total_tags': round(avg_tags or 0, 2),
                    'avg_custom_tags': round(avg_custom or 0, 2),
                    'comment_rate_percentage': round(with_comments / total * 100, 2) if total > 0 else 0,
                    'tag_usage_rate_percentage': round(with_tags / total * 100, 2) if total > 0 else 0,
                    'custom_tag_usage_rate_percentage': round(with_custom / total * 100, 2) if total > 0 else 0,
                    'total_submissions': total
                }
            else:
                return {
                    'avg_comment_length': 0,
                    'avg_total_tags': 0,
                    'avg_custom_tags': 0,
                    'comment_rate_percentage': 0,
                    'tag_usage_rate_percentage': 0,
                    'custom_tag_usage_rate_percentage': 0,
                    'total_submissions': 0
                }
        
        # Get stats for both weeks
        current_week_stats = get_week_quality_stats(current_week_start, current_week_end)
        previous_week_stats = get_week_quality_stats(previous_week_start, previous_week_end)
        
        # Get all-time stats
        cursor.execute("""
            SELECT AVG(comment_length) as avg_comment_length,
                   AVG(total_tags) as avg_total_tags,
                   AVG(custom_tags_count) as avg_custom_tags,
                   COUNT(*) as total_submissions,
                   SUM(CASE WHEN comment_length > 0 THEN 1 ELSE 0 END) as submissions_with_comments,
                   SUM(CASE WHEN total_tags > 0 THEN 1 ELSE 0 END) as submissions_with_tags,
                   SUM(CASE WHEN custom_tags_count > 0 THEN 1 ELSE 0 END) as submissions_with_custom_tags
            FROM mood_submissions
        """)
        
        result = cursor.fetchone()
        if result and result[3] > 0:  # total_submissions > 0
            avg_comment, avg_tags, avg_custom, total, with_comments, with_tags, with_custom = result
            all_time_stats = {
                'avg_comment_length': round(avg_comment or 0, 2),
                'avg_total_tags': round(avg_tags or 0, 2),
                'avg_custom_tags': round(avg_custom or 0, 2),
                'comment_rate_percentage': round(with_comments / total * 100, 2) if total > 0 else 0,
                'tag_usage_rate_percentage': round(with_tags / total * 100, 2) if total > 0 else 0,
                'custom_tag_usage_rate_percentage': round(with_custom / total * 100, 2) if total > 0 else 0,
                'total_submissions': total
            }
        else:
            all_time_stats = {
                'avg_comment_length': 0,
                'avg_total_tags': 0,
                'avg_custom_tags': 0,
                'comment_rate_percentage': 0,
                'tag_usage_rate_percentage': 0,
                'custom_tag_usage_rate_percentage': 0,
                'total_submissions': 0
            }
        
        # Calculate changes
        def calculate_change(current, previous):
            """Calculate absolute and percentage change"""
            absolute_change = current - previous
            if previous == 0:
                percentage_change = 0 if current == 0 else 100
            else:
                percentage_change = round((absolute_change / previous) * 100, 1)
            return {
                'absolute': round(absolute_change, 2),
                'percentage': percentage_change
            }
        
        # Calculate changes for each metric
        changes = {
            'avg_comment_length': calculate_change(
                current_week_stats['avg_comment_length'], 
                previous_week_stats['avg_comment_length']
            ),
            'comment_rate_percentage': calculate_change(
                current_week_stats['comment_rate_percentage'], 
                previous_week_stats['comment_rate_percentage']
            ),
            'avg_total_tags': calculate_change(
                current_week_stats['avg_total_tags'], 
                previous_week_stats['avg_total_tags']
            ),
            'custom_tag_usage_rate_percentage': calculate_change(
                current_week_stats['custom_tag_usage_rate_percentage'], 
                previous_week_stats['custom_tag_usage_rate_percentage']
            )
        }
        
        # Create grouped bar chart showing all three time periods
        metrics = ['Comments', 'Tags', 'Custom Tags']
        
        current_week_data = [
            current_week_stats['comment_rate_percentage'],
            current_week_stats['tag_usage_rate_percentage'],
            current_week_stats['custom_tag_usage_rate_percentage']
        ]
        
        previous_week_data = [
            previous_week_stats['comment_rate_percentage'],
            previous_week_stats['tag_usage_rate_percentage'],
            previous_week_stats['custom_tag_usage_rate_percentage']
        ]
        
        all_time_data = [
            all_time_stats['comment_rate_percentage'],
            all_time_stats['tag_usage_rate_percentage'],
            all_time_stats['custom_tag_usage_rate_percentage']
        ]
        
        fig_quality = go.Figure()
        
        # Add bars for each time period
        fig_quality.add_trace(go.Bar(
            name='Current Week',
            x=metrics,
            y=current_week_data,
            marker_color='#3498db',
            text=[f"{p:.1f}%" for p in current_week_data],
            textposition='auto'
        ))
        
        fig_quality.add_trace(go.Bar(
            name='Previous Week',
            x=metrics,
            y=previous_week_data,
            marker_color='#95a5a6',
            text=[f"{p:.1f}%" for p in previous_week_data],
            textposition='auto'
        ))
        
        fig_quality.add_trace(go.Bar(
            name='All Time',
            x=metrics,
            y=all_time_data,
            marker_color='#2ecc71',
            text=[f"{p:.1f}%" for p in all_time_data],
            textposition='auto'
        ))
        
        fig_quality.update_layout(
            title="Content Feature Usage Rates Comparison",
            yaxis_title="Usage Rate (%)",
            font=dict(size=12),
            margin=dict(t=60, b=40, l=40, r=40),
            barmode='group',  # Group bars side by side
            legend=dict(
                orientation="h",
                yanchor="bottom",
                y=1.02,
                xanchor="right",
                x=1
            )
        )
        
        quality_chart = self.create_chart_references(fig_quality, 'content_quality')
        
        return {
            'current_week_stats': current_week_stats,
            'previous_week_stats': previous_week_stats,
            'all_time_stats': all_time_stats,
            'changes': changes,
            'date_ranges': {
                'current_week': f"{current_week_start.strftime('%m/%d')} - {(today - timedelta(days=1)).strftime('%m/%d')}",
                'previous_week': f"{previous_week_start.strftime('%m/%d')} - {(previous_week_end - timedelta(days=1)).strftime('%m/%d')}"
            },
            'charts': {
                'content_quality': quality_chart
            }
        }

    def get_retention_metrics(self):
        """Calculate detailed retention and churn metrics"""
        cursor = self.analytics_conn.cursor()
        
        # User retention buckets
        cursor.execute("""
            SELECT user_id,
                   DATE(MIN(submission_datetime)) as first_submission_date,
                   DATE(MAX(submission_datetime)) as last_submission_date,
                   COUNT(DISTINCT DATE(submission_datetime)) as active_days,
                   COUNT(*) as total_submissions
            FROM mood_submissions
            GROUP BY user_id
        """)
        
        users_data = cursor.fetchall()
        
        if not users_data:
            return {'error': 'No retention data available'}
        
        # Calculate retention buckets
        now = datetime.now().date()
        retention_buckets = {
            'active_last_7_days': 0,
            'active_last_30_days': 0,
            'dormant_30_90_days': 0,
            'churned_90_plus_days': 0
        }
        
        total_users = len(users_data)
        
        for user_id, first_date, last_date, active_days, submissions in users_data:
            last_activity = datetime.strptime(last_date, '%Y-%m-%d').date()
            days_since_last_activity = (now - last_activity).days
            
            if days_since_last_activity <= 7:
                retention_buckets['active_last_7_days'] += 1
            elif days_since_last_activity <= 30:
                retention_buckets['active_last_30_days'] += 1
            elif days_since_last_activity <= 90:
                retention_buckets['dormant_30_90_days'] += 1
            else:
                retention_buckets['churned_90_plus_days'] += 1
        
        # Create retention visualization
        labels = ['Active (7d)', 'Active (30d)', 'Dormant (30-90d)', 'Churned (90d+)']
        values = list(retention_buckets.values())
        colors = ['#2ecc71', '#3498db', '#f39c12', '#e74c3c']
        
        fig_retention = go.Figure(data=[go.Pie(
            labels=labels,
            values=values,
            hole=0.4,
            marker_colors=colors,
            textinfo='label+percent+value',
            textfont_size=11
        )])
        fig_retention.update_layout(
            title="User Retention Status",
            font=dict(size=12),
            margin=dict(t=60, b=40, l=40, r=40)
        )
        
        retention_chart = self.create_chart_references(fig_retention, 'retention_status')
        
        # Convert to percentages
        retention_percentages = {}
        for bucket, count in retention_buckets.items():
            retention_percentages[f"{bucket}_percentage"] = round(count / total_users * 100, 2) if total_users > 0 else 0
        
        return {
            'total_users_analyzed': total_users,
            'retention_buckets': retention_buckets,
            'retention_percentages': retention_percentages,
            'charts': {
                'retention_status': retention_chart
            }
        }

    def get_business_metrics(self):
        """Calculate key business metrics"""
        # Get account level information from main database
        main_cursor = self.main_conn.cursor()
        analytics_cursor = self.analytics_conn.cursor()
        
        # Check if analytics table exists
        analytics_cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mood_submissions'")
        if not analytics_cursor.fetchone():
            return {'error': 'Analytics table not found'}
        
        # Get all users by account level
        main_cursor.execute("""
            SELECT accountLevel, COUNT(*) as total_users
            FROM users
            WHERE isVerified = 1
            GROUP BY accountLevel
        """)
        
        total_users_by_level = {}
        for row in main_cursor.fetchall():
            level, count = row
            total_users_by_level[level] = count
        
        # Get active users from analytics (last 30 days)
        start_date = self.date_ranges['past_30_days'][0]
        analytics_cursor.execute("""
            SELECT DISTINCT user_id
            FROM mood_submissions 
            WHERE DATE(submission_datetime) >= ?
        """, (start_date.isoformat(),))
        
        active_user_ids = [row[0] for row in analytics_cursor.fetchall()]
        
        # Now get account levels for active users
        account_level_activity = {}
        if active_user_ids:
            placeholders = ','.join('?' * len(active_user_ids))
            main_cursor.execute(f"""
                SELECT accountLevel, COUNT(*) as active_users
                FROM users
                WHERE isVerified = 1 AND id IN ({placeholders})
                GROUP BY accountLevel
            """, active_user_ids)
            
            for row in main_cursor.fetchall():
                level, count = row
                account_level_activity[level] = count
        
        # Calculate Monthly Active Users (MAU)
        mau = len(active_user_ids)
        
        # Calculate Daily Active Users for the last 7 days
        dau_start = self.date_ranges['past_7_days'][0]
        analytics_cursor.execute("""
            SELECT DATE(submission_datetime) as date, COUNT(DISTINCT user_id) as dau
            FROM mood_submissions
            WHERE DATE(submission_datetime) >= ?
            GROUP BY DATE(submission_datetime)
            ORDER BY date DESC
        """, (dau_start.isoformat(),))
        
        daily_active_users = {}
        total_dau = 0
        day_count = 0
        for row in analytics_cursor.fetchall():
            date, dau = row
            daily_active_users[date] = dau
            total_dau += dau
            day_count += 1
        
        avg_dau = total_dau / day_count if day_count > 0 else 0
        
        return {
            'monthly_active_users': mau,
            'avg_daily_active_users': round(avg_dau, 2),
            'daily_active_users_detail': daily_active_users,
            'active_users_by_account_level': account_level_activity,
            'total_users_by_level': total_users_by_level
        }

    def generate_html_report(self):
        """Generate comprehensive HTML report with charts"""
        # Collect all metrics
        user_metrics = self.get_user_metrics()
        engagement_metrics = self.get_engagement_metrics()
        content_metrics = self.get_content_quality_metrics()
        retention_metrics = self.get_retention_metrics()
        business_metrics = self.get_business_metrics()
        
        current_date = datetime.now().strftime("%B %d, %Y")
        
        # Calculate key highlights
        total_users = user_metrics['total_users']
        past_week_users = engagement_metrics.get('volume_stats', {}).get('past_7_days', {}).get('unique_users', 0)
        past_month_users = engagement_metrics.get('volume_stats', {}).get('past_30_days', {}).get('unique_users', 0)
        
        week_engagement = (past_week_users / total_users * 100) if total_users > 0 else 0
        month_engagement = (past_month_users / total_users * 100) if total_users > 0 else 0
        
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Moodful Analytics Report</title>
            <style>
                body {{
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 20px;
                    background-color: #f8f9fa;
                }}
                .container {{
                    max-width: 1200px;
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
                    font-size: 2.5em;
                    font-weight: 300;
                }}
                .header p {{
                    margin: 10px 0 0 0;
                    font-size: 1.2em;
                    opacity: 0.9;
                }}
                .content {{
                    padding: 40px;
                }}
                .kpi-grid {{
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-bottom: 40px;
                    justify-content: space-between;
                }}
                .kpi-card {{
                    background: #fff;
                    border-radius: 10px;
                    padding: 25px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    border-left: 4px solid #667eea;
                    transition: transform 0.2s;
                    flex: 1;
                    min-width: 200px;
                    max-width: 280px;
                }}
                .kpi-card:hover {{
                    transform: translateY(-2px);
                }}
                .kpi-value {{
                    font-size: 2.5em;
                    font-weight: bold;
                    color: #667eea;
                    margin: 0;
                }}
                .kpi-label {{
                    color: #6c757d;
                    font-size: 0.9em;
                    margin: 5px 0 0 0;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }}
                .section {{
                    margin-bottom: 50px;
                }}
                .section-title {{
                    font-size: 1.8em;
                    color: #2c3e50;
                    margin-bottom: 25px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid #667eea;
                }}
                .chart-container {{
                    text-align: center;
                    margin: 30px 0;
                    padding: 20px;
                    background: #f8f9fa;
                    border-radius: 10px;
                }}
                .chart-container img {{
                    max-width: 100%;
                    height: auto;
                    border-radius: 8px;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                }}
                .stats-grid {{
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-bottom: 20px;
                }}
                .stats-card {{
                    background: #fff;
                    border-radius: 8px;
                    padding: 20px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    flex: 1;
                    min-width: 300px;
                }}
                .stats-card h4 {{
                    color: #667eea;
                    margin-top: 0;
                }}
                .stat-item {{
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid #eee;
                }}
                .stat-item:last-child {{
                    border-bottom: none;
                }}
                .positive {{
                    color: #28a745;
                    font-weight: bold;
                }}
                .negative {{
                    color: #dc3545;
                    font-weight: bold;
                }}
                .neutral {{
                    color: #6c757d;
                }}
                .footer {{
                    background: #f8f9fa;
                    padding: 30px;
                    text-align: center;
                    color: #6c757d;
                    border-top: 1px solid #dee2e6;
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📊 Moodful Analytics Report</h1>
                    <p>Comprehensive insights for {current_date}</p>
                </div>
                
                <div class="content">
                    <!-- Key Performance Indicators -->
                    <div class="section">
                        <div class="kpi-grid" style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 40px; justify-content: space-between;">
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{total_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Total Verified Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{past_week_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Weekly Active Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{past_month_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Monthly Active Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{week_engagement:.1f}%</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Weekly Engagement Rate</div>
                            </div>
                        </div>
                    </div>
        """
        
        # Add User Distribution section
        if user_metrics.get('charts', {}).get('user_distribution'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">👥 User Distribution</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Account Levels</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Basic Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{user_metrics['user_counts']['basic']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Pro Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{user_metrics['user_counts']['pro']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Enterprise Users</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold;">{user_metrics['user_counts']['enterprise']:,}</td>
                                        </tr>
                                    </table>
                                </td>
                                <td width="50%"></td>
                            </tr>
                        </table>
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:user_distribution" alt="User Distribution Chart" style="max-width: 100%; height: auto;">
                        </div>
                    </div>
            """
        
        # Add Engagement Metrics section
        if not engagement_metrics.get('error'):
            current_week_platforms = engagement_metrics.get('current_week_platforms', {})
            previous_week_platforms = engagement_metrics.get('previous_week_platforms', {})
            all_time_platforms = engagement_metrics.get('all_time_platforms', {})
            platform_changes = engagement_metrics.get('platform_changes', {})
            date_ranges = engagement_metrics.get('date_ranges', {})
            
            def format_platform_change(change_data):
                """Format platform change with color coding"""
                absolute = change_data['absolute']
                percentage = change_data['percentage']
                
                # Determine color based on change direction
                if absolute > 0:
                    color = "#28a745"  # Green for positive
                    symbol = "+"
                elif absolute < 0:
                    color = "#dc3545"  # Red for negative  
                    symbol = ""
                else:
                    color = "#6c757d"  # Gray for no change
                    symbol = ""
                
                return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute} ({symbol}{percentage:.1f}%)</span>'
            
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">📈 Engagement Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="100%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="10" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; font-weight: bold; width: 25%;">Platform</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Current Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges.get('current_week', '')})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Previous Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges.get('previous_week', '')})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Change</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 15%;">All Time</td>
                                        </tr>
            """
            
            # Get all platforms and sort by all-time submission count
            all_platforms = set()
            all_platforms.update(current_week_platforms.keys())
            all_platforms.update(previous_week_platforms.keys())
            all_platforms.update(all_time_platforms.keys())
            
            # Sort platforms by all-time submission count (descending)
            sorted_platforms = sorted(all_platforms, 
                                    key=lambda x: all_time_platforms.get(x, {}).get('submission_count', 0), 
                                    reverse=True)
            
            # Add rows for each platform
            for i, platform in enumerate(sorted_platforms):
                current_count = current_week_platforms.get(platform, {}).get('submission_count', 0)
                previous_count = previous_week_platforms.get(platform, {}).get('submission_count', 0)
                all_time_count = all_time_platforms.get(platform, {}).get('submission_count', 0)
                change = platform_changes.get(platform, {'absolute': 0, 'percentage': 0})
                
                # Skip platforms with no all-time data
                if all_time_count == 0:
                    continue
                
                border_style = "border-bottom: 1px solid #eee;" if i < len(sorted_platforms) - 1 else ""
                
                html_content += f"""
                                        <tr>
                                            <td style="padding: 12px 15px; {border_style}">{platform.title()}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold;">{current_count:,}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold;">{previous_count:,}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center;">{format_platform_change(change)}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold; color: #2ecc71;">{all_time_count:,}</td>
                                        </tr>
                """
            
            html_content += """
                                    </table>
                                </td>
                            </tr>
                        </table>
            """
            
            # Add platform usage chart
            if engagement_metrics.get('charts', {}).get('platform_usage'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:platform_usage" alt="Platform Usage Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            # Add daily activity chart
            if engagement_metrics.get('charts', {}).get('daily_activity'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:daily_activity" alt="Daily Activity Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Content Quality section
        if not content_metrics.get('error') and content_metrics.get('current_week_stats'):
            current_week_stats = content_metrics['current_week_stats']
            previous_week_stats = content_metrics['previous_week_stats']
            all_time_stats = content_metrics['all_time_stats']
            changes = content_metrics['changes']
            date_ranges = content_metrics['date_ranges']
            
            def format_change(change_data, is_percentage=False):
                """Format change with color coding"""
                absolute = change_data['absolute']
                percentage = change_data['percentage']
                
                # Determine color based on change direction
                if absolute > 0:
                    color = "#28a745"  # Green for positive
                    symbol = "+"
                elif absolute < 0:
                    color = "#dc3545"  # Red for negative  
                    symbol = ""
                else:
                    color = "#6c757d"  # Gray for no change
                    symbol = ""
                
                if is_percentage:
                    return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute:.1f}pp ({symbol}{percentage:.1f}%)</span>'
                else:
                    return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute} ({symbol}{percentage:.1f}%)</span>'
            
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">✍️ Content Quality Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="100%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="10" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; font-weight: bold; width: 25%;">Metric</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Current Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges['current_week']})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Previous Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges['previous_week']})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Change</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 15%;">All Time</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Average Comment Length</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['avg_comment_length']} chars</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['avg_comment_length']} chars</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['avg_comment_length'])}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['avg_comment_length']} chars</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Comment Usage Rate</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['comment_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['comment_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['comment_rate_percentage'], is_percentage=True)}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['comment_rate_percentage']}%</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Average Tags per Submission</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['avg_total_tags']}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['avg_total_tags']}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['avg_total_tags'])}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['avg_total_tags']}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px;">Custom Tag Usage Rate</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold;">{current_week_stats['custom_tag_usage_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold;">{previous_week_stats['custom_tag_usage_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; text-align: center;">{format_change(changes['custom_tag_usage_rate_percentage'], is_percentage=True)}</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['custom_tag_usage_rate_percentage']}%</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
            """
            
            if content_metrics.get('charts', {}).get('content_quality'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:content_quality" alt="Content Quality Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Retention section
        if not retention_metrics.get('error'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">🔄 User Retention Analysis</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Retention Breakdown</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Active (Last 7 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #28a745;">{retention_metrics['retention_buckets']['active_last_7_days']:,} ({retention_metrics['retention_percentages']['active_last_7_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Active (Last 30 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #28a745;">{retention_metrics['retention_buckets']['active_last_30_days']:,} ({retention_metrics['retention_percentages']['active_last_30_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Dormant (30-90 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #6c757d;">{retention_metrics['retention_buckets']['dormant_30_90_days']:,} ({retention_metrics['retention_percentages']['dormant_30_90_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Churned (90+ Days)</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold; color: #dc3545;">{retention_metrics['retention_buckets']['churned_90_plus_days']:,} ({retention_metrics['retention_percentages']['churned_90_plus_days_percentage']}%)</td>
                                        </tr>
                                    </table>
                                </td>
                                <td width="50%"></td>
                            </tr>
                        </table>
            """
            
            if retention_metrics.get('charts', {}).get('retention_status'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:retention_status" alt="Retention Status Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Business Metrics section
        if not business_metrics.get('error'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">💼 Business Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Key Business Indicators</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Monthly Active Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{business_metrics['monthly_active_users']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Average Daily Active Users</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold;">{business_metrics['avg_daily_active_users']}</td>
                                        </tr>
                                    </table>
                                </td>
            """
            
            if business_metrics.get('active_users_by_account_level'):
                html_content += """
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Active Users by Account Level</h4>
                                            </td>
                                        </tr>
                """
                level_list = list(business_metrics['active_users_by_account_level'].items())
                for i, (level, count) in enumerate(level_list):
                    border_style = "border-bottom: 1px solid #eee;" if i < len(level_list) - 1 else ""
                    html_content += f"""
                                        <tr>
                                            <td style="padding: 10px 15px; {border_style}">{level.title()}</td>
                                            <td style="padding: 10px 15px; {border_style} text-align: right; font-weight: bold;">{count:,} users</td>
                                        </tr>
                    """
                html_content += """
                                    </table>
                                </td>
                """
            else:
                html_content += '<td width="50%"></td>'
            
            html_content += """
                            </tr>
                        </table>
                    </div>
            """
        
        # Footer
        html_content += f"""
                </div>
                
                <div class="footer">
                    <p>Generated on {datetime.now().strftime('%Y-%m-%d at %H:%M:%S')} | Moodful Analytics System</p>
                    <p>This report provides insights into user engagement, content quality, and business performance.</p>
                </div>
            </div>
        </body>
        </html>
        """
        
        return html_content

    def generate_email_html_report(self):
        """Generate HTML report with CID image references for email"""
        # First generate the base HTML with all metrics
        # Collect all metrics
        user_metrics = self.get_user_metrics()
        engagement_metrics = self.get_engagement_metrics()
        content_metrics = self.get_content_quality_metrics()
        retention_metrics = self.get_retention_metrics()
        business_metrics = self.get_business_metrics()
        
        current_date = datetime.now().strftime("%B %d, %Y")
        
        # Calculate key highlights
        total_users = user_metrics['total_users']
        past_week_users = engagement_metrics.get('volume_stats', {}).get('past_7_days', {}).get('unique_users', 0)
        past_month_users = engagement_metrics.get('volume_stats', {}).get('past_30_days', {}).get('unique_users', 0)
        
        week_engagement = (past_week_users / total_users * 100) if total_users > 0 else 0
        month_engagement = (past_month_users / total_users * 100) if total_users > 0 else 0
        
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Moodful Analytics Report</title>
            <style>
                body {{
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 20px;
                    background-color: #f8f9fa;
                }}
                .container {{
                    max-width: 1200px;
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
                    font-size: 2.5em;
                    font-weight: 300;
                }}
                .header p {{
                    margin: 10px 0 0 0;
                    font-size: 1.2em;
                    opacity: 0.9;
                }}
                .content {{
                    padding: 40px;
                }}
                .kpi-grid {{
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-bottom: 40px;
                    justify-content: space-between;
                }}
                .kpi-card {{
                    background: #fff;
                    border-radius: 10px;
                    padding: 25px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    border-left: 4px solid #667eea;
                    transition: transform 0.2s;
                    flex: 1;
                    min-width: 200px;
                    max-width: 280px;
                }}
                .kpi-card:hover {{
                    transform: translateY(-2px);
                }}
                .kpi-value {{
                    font-size: 2.5em;
                    font-weight: bold;
                    color: #667eea;
                    margin: 0;
                }}
                .kpi-label {{
                    color: #6c757d;
                    font-size: 0.9em;
                    margin: 5px 0 0 0;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }}
                .section {{
                    margin-bottom: 50px;
                }}
                .section-title {{
                    font-size: 1.8em;
                    color: #2c3e50;
                    margin-bottom: 25px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid #667eea;
                }}
                .chart-container {{
                    text-align: center;
                    margin: 30px 0;
                    padding: 20px;
                    background: #f8f9fa;
                    border-radius: 10px;
                }}
                .chart-container img {{
                    max-width: 100%;
                    height: auto;
                    border-radius: 8px;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                }}
                .stats-grid {{
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                    margin-bottom: 20px;
                }}
                .stats-card {{
                    background: #fff;
                    border-radius: 8px;
                    padding: 20px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    flex: 1;
                    min-width: 300px;
                }}
                .stats-card h4 {{
                    color: #667eea;
                    margin-top: 0;
                }}
                .stat-item {{
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid #eee;
                }}
                .stat-item:last-child {{
                    border-bottom: none;
                }}
                .positive {{
                    color: #28a745;
                    font-weight: bold;
                }}
                .negative {{
                    color: #dc3545;
                    font-weight: bold;
                }}
                .neutral {{
                    color: #6c757d;
                }}
                .footer {{
                    background: #f8f9fa;
                    padding: 30px;
                    text-align: center;
                    color: #6c757d;
                    border-top: 1px solid #dee2e6;
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📊 Moodful Analytics Report</h1>
                    <p>Comprehensive insights for {current_date}</p>
                </div>
                
                <div class="content">
                    <!-- Key Performance Indicators -->
                    <div class="section">
                        <div class="kpi-grid" style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 40px; justify-content: space-between;">
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{total_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Total Verified Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{past_week_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Weekly Active Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{past_month_users:,}</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Monthly Active Users</div>
                            </div>
                            <div class="kpi-card" style="background: #fff; border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-left: 4px solid #667eea; flex: 1; min-width: 200px; max-width: 280px;">
                                <div class="kpi-value" style="font-size: 2.5em; font-weight: bold; color: #667eea; margin: 0;">{week_engagement:.1f}%</div>
                                <div class="kpi-label" style="color: #6c757d; font-size: 0.9em; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 0.5px;">Weekly Engagement Rate</div>
                            </div>
                        </div>
                    </div>
        """
        
        # Add User Distribution section
        if user_metrics.get('charts', {}).get('user_distribution'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">👥 User Distribution</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Account Levels</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Basic Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{user_metrics['user_counts']['basic']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Pro Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{user_metrics['user_counts']['pro']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Enterprise Users</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold;">{user_metrics['user_counts']['enterprise']:,}</td>
                                        </tr>
                                    </table>
                                </td>
                                <td width="50%"></td>
                            </tr>
                        </table>
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:user_distribution" alt="User Distribution Chart" style="max-width: 100%; height: auto;">
                        </div>
                    </div>
            """
        
        # Add Engagement Metrics section
        if not engagement_metrics.get('error'):
            current_week_platforms = engagement_metrics.get('current_week_platforms', {})
            previous_week_platforms = engagement_metrics.get('previous_week_platforms', {})
            all_time_platforms = engagement_metrics.get('all_time_platforms', {})
            platform_changes = engagement_metrics.get('platform_changes', {})
            date_ranges = engagement_metrics.get('date_ranges', {})
            
            def format_platform_change(change_data):
                """Format platform change with color coding"""
                absolute = change_data['absolute']
                percentage = change_data['percentage']
                
                # Determine color based on change direction
                if absolute > 0:
                    color = "#28a745"  # Green for positive
                    symbol = "+"
                elif absolute < 0:
                    color = "#dc3545"  # Red for negative  
                    symbol = ""
                else:
                    color = "#6c757d"  # Gray for no change
                    symbol = ""
                
                return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute} ({symbol}{percentage:.1f}%)</span>'
            
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">📈 Engagement Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="100%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="10" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; font-weight: bold; width: 25%;">Platform</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Current Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges.get('current_week', '')})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Previous Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges.get('previous_week', '')})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Change</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 15%;">All Time</td>
                                        </tr>
            """
            
            # Get all platforms and sort by all-time submission count
            all_platforms = set()
            all_platforms.update(current_week_platforms.keys())
            all_platforms.update(previous_week_platforms.keys())
            all_platforms.update(all_time_platforms.keys())
            
            # Sort platforms by all-time submission count (descending)
            sorted_platforms = sorted(all_platforms, 
                                    key=lambda x: all_time_platforms.get(x, {}).get('submission_count', 0), 
                                    reverse=True)
            
            # Add rows for each platform
            for i, platform in enumerate(sorted_platforms):
                current_count = current_week_platforms.get(platform, {}).get('submission_count', 0)
                previous_count = previous_week_platforms.get(platform, {}).get('submission_count', 0)
                all_time_count = all_time_platforms.get(platform, {}).get('submission_count', 0)
                change = platform_changes.get(platform, {'absolute': 0, 'percentage': 0})
                
                # Skip platforms with no all-time data
                if all_time_count == 0:
                    continue
                
                border_style = "border-bottom: 1px solid #eee;" if i < len(sorted_platforms) - 1 else ""
                
                html_content += f"""
                                        <tr>
                                            <td style="padding: 12px 15px; {border_style}">{platform.title()}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold;">{current_count:,}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold;">{previous_count:,}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center;">{format_platform_change(change)}</td>
                                            <td style="padding: 12px 15px; {border_style} text-align: center; font-weight: bold; color: #2ecc71;">{all_time_count:,}</td>
                                        </tr>
                """
            
            html_content += """
                                    </table>
                                </td>
                            </tr>
                        </table>
            """
            
            # Add platform usage chart
            if engagement_metrics.get('charts', {}).get('platform_usage'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:platform_usage" alt="Platform Usage Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            # Add daily activity chart
            if engagement_metrics.get('charts', {}).get('daily_activity'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:daily_activity" alt="Daily Activity Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Content Quality section
        if not content_metrics.get('error') and content_metrics.get('current_week_stats'):
            current_week_stats = content_metrics['current_week_stats']
            previous_week_stats = content_metrics['previous_week_stats']
            all_time_stats = content_metrics['all_time_stats']
            changes = content_metrics['changes']
            date_ranges = content_metrics['date_ranges']
            
            def format_change(change_data, is_percentage=False):
                """Format change with color coding"""
                absolute = change_data['absolute']
                percentage = change_data['percentage']
                
                # Determine color based on change direction
                if absolute > 0:
                    color = "#28a745"  # Green for positive
                    symbol = "+"
                elif absolute < 0:
                    color = "#dc3545"  # Red for negative  
                    symbol = ""
                else:
                    color = "#6c757d"  # Gray for no change
                    symbol = ""
                
                if is_percentage:
                    return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute:.1f}pp ({symbol}{percentage:.1f}%)</span>'
                else:
                    return f'<span style="color: {color}; font-weight: bold;">{symbol}{absolute} ({symbol}{percentage:.1f}%)</span>'
            
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">✍️ Content Quality Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="100%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="10" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; font-weight: bold; width: 25%;">Metric</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Current Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges['current_week']})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Previous Week<br><small style="font-weight: normal; color: #6c757d;">({date_ranges['previous_week']})</small></td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 20%;">Change</td>
                                            <td style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px; text-align: center; font-weight: bold; width: 15%;">All Time</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Average Comment Length</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['avg_comment_length']} chars</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['avg_comment_length']} chars</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['avg_comment_length'])}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['avg_comment_length']} chars</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Comment Usage Rate</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['comment_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['comment_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['comment_rate_percentage'], is_percentage=True)}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['comment_rate_percentage']}%</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee;">Average Tags per Submission</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{current_week_stats['avg_total_tags']}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold;">{previous_week_stats['avg_total_tags']}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center;">{format_change(changes['avg_total_tags'])}</td>
                                            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['avg_total_tags']}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 12px 15px;">Custom Tag Usage Rate</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold;">{current_week_stats['custom_tag_usage_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold;">{previous_week_stats['custom_tag_usage_rate_percentage']}%</td>
                                            <td style="padding: 12px 15px; text-align: center;">{format_change(changes['custom_tag_usage_rate_percentage'], is_percentage=True)}</td>
                                            <td style="padding: 12px 15px; text-align: center; font-weight: bold; color: #2ecc71;">{all_time_stats['custom_tag_usage_rate_percentage']}%</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
            """
            
            if content_metrics.get('charts', {}).get('content_quality'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:content_quality" alt="Content Quality Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Retention section
        if not retention_metrics.get('error'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">🔄 User Retention Analysis</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Retention Breakdown</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Active (Last 7 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #28a745;">{retention_metrics['retention_buckets']['active_last_7_days']:,} ({retention_metrics['retention_percentages']['active_last_7_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Active (Last 30 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #28a745;">{retention_metrics['retention_buckets']['active_last_30_days']:,} ({retention_metrics['retention_percentages']['active_last_30_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Dormant (30-90 Days)</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #6c757d;">{retention_metrics['retention_buckets']['dormant_30_90_days']:,} ({retention_metrics['retention_percentages']['dormant_30_90_days_percentage']}%)</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Churned (90+ Days)</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold; color: #dc3545;">{retention_metrics['retention_buckets']['churned_90_plus_days']:,} ({retention_metrics['retention_percentages']['churned_90_plus_days_percentage']}%)</td>
                                        </tr>
                                    </table>
                                </td>
                                <td width="50%"></td>
                            </tr>
                        </table>
            """
            
            if retention_metrics.get('charts', {}).get('retention_status'):
                html_content += f"""
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa;">
                            <img src="cid:retention_status" alt="Retention Status Chart" style="max-width: 100%; height: auto;">
                        </div>
                """
            
            html_content += "</div>"
        
        # Add Business Metrics section
        if not business_metrics.get('error'):
            html_content += f"""
                    <div class="section">
                        <h2 style="font-size: 1.8em; color: #2c3e50; margin-bottom: 25px; padding-bottom: 10px; border-bottom: 2px solid #667eea;">💼 Business Metrics</h2>
                        <table width="100%" cellpadding="0" cellspacing="20" style="margin-bottom: 20px;">
                            <tr>
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Key Business Indicators</h4>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee;">Monthly Active Users</td>
                                            <td style="padding: 10px 15px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">{business_metrics['monthly_active_users']:,}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 10px 15px;">Average Daily Active Users</td>
                                            <td style="padding: 10px 15px; text-align: right; font-weight: bold;">{business_metrics['avg_daily_active_users']}</td>
                                        </tr>
                                    </table>
                                </td>
            """
            
            if business_metrics.get('active_users_by_account_level'):
                html_content += """
                                <td width="50%" style="vertical-align: top;">
                                    <table width="100%" cellpadding="15" cellspacing="0" style="background: #fff; border: 1px solid #ddd;">
                                        <tr>
                                            <td colspan="2" style="background: #f8f9fa; border-bottom: 1px solid #ddd; padding: 15px;">
                                                <h4 style="color: #667eea; margin: 0; font-size: 1.1em;">Active Users by Account Level</h4>
                                            </td>
                                        </tr>
                """
                level_list = list(business_metrics['active_users_by_account_level'].items())
                for i, (level, count) in enumerate(level_list):
                    border_style = "border-bottom: 1px solid #eee;" if i < len(level_list) - 1 else ""
                    html_content += f"""
                                        <tr>
                                            <td style="padding: 10px 15px; {border_style}">{level.title()}</td>
                                            <td style="padding: 10px 15px; {border_style} text-align: right; font-weight: bold;">{count:,} users</td>
                                        </tr>
                    """
                html_content += """
                                    </table>
                                </td>
                """
            else:
                html_content += '<td width="50%"></td>'
            
            html_content += """
                            </tr>
                        </table>
                    </div>
            """
        
        # Footer
        html_content += f"""
                </div>
                
                <div class="footer">
                    <p>Generated on {datetime.now().strftime('%Y-%m-%d at %H:%M:%S')} | Moodful Analytics System</p>
                    <p>This report provides insights into user engagement, content quality, and business performance.</p>
                </div>
            </div>
        </body>
        </html>
        """
        
        return html_content

def send_analytics_email(html_content, chart_files=None):
    """Send the analytics report via email with proper inline images"""
    try:
        message_id = f"<{uuid.uuid4()}@{MAILGUN_DOMAIN}>"
        current_date = datetime.now().strftime("%Y-%m-%d")
        
        # Create a multipart message
        msg = MIMEMultipart('related')
        msg['From'] = f"Moodful Analytics <{SENDER_EMAIL}>"
        msg['To'] = RECIPIENT_EMAIL
        msg['Subject'] = f"📊 Moodful Analytics Report - {current_date}"
        msg['Message-ID'] = message_id
        
        # Add HTML content
        msg_text = MIMEText(html_content, 'html')
        msg.attach(msg_text)
        
        # Add inline images
        if chart_files:
            for cid, filepath in chart_files.items():
                if filepath and os.path.exists(filepath):
                    with open(filepath, 'rb') as f:
                        img_data = f.read()
                    
                    img = MIMEImage(img_data)
                    img.add_header('Content-ID', f'<{cid}>')
                    img.add_header('Content-Disposition', 'inline', filename=f'{cid}.png')
                    msg.attach(img)
        
        # Send via Mailgun using raw MIME
        response = requests.post(
            f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages.mime",
            auth=("api", MAILGUN_API_KEY),
            data={
                "to": [RECIPIENT_EMAIL],
            },
            files={
                "message": ("message.mime", msg.as_bytes(), "message/rfc822")
            }
        )
        
        response.raise_for_status()
        print("✅ Analytics report sent successfully with inline images")
        
        # Clean up temporary chart files
        if chart_files:
            for filepath in chart_files.values():
                if filepath and os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                    except:
                        pass
                        
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to send analytics report. Error: {str(e)}")
        print(f"Response: {e.response.text if hasattr(e, 'response') else 'No response'}")
        # Clean up temporary chart files even on error
        if chart_files:
            for filepath in chart_files.values():
                if filepath and os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                    except:
                        pass

def main():
    """Main function to generate and send analytics report"""
    print("🔄 Generating Moodful Analytics Report...")
    
    try:
        analytics = MoodfulAnalytics()
        
        # Generate email version with CID references and file attachments
        email_html = analytics.generate_email_html_report()
        
        # Send email with chart files as attachments
        if analytics.chart_files:
            send_analytics_email(email_html, analytics.chart_files)
        else:
            send_analytics_email(email_html)
            
        print("✅ Analytics report generation completed successfully!")
        
    except Exception as e:
        print(f"❌ Error generating analytics report: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()