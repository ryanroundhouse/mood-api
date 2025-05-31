# Moodful Analytics System

## Overview

The enhanced analytics system provides comprehensive insights into user behavior, engagement patterns, content quality, and business metrics for Moodful. It generates beautiful, professional reports with interactive charts and detailed KPIs.

## Files

- `calculate-usage-stats.py` - Main analytics script that generates comprehensive reports
- `test-analytics.py` - Test script to generate local HTML previews
- `analytics_report.html` - Generated HTML report (created when running test script)

## Features

### 📊 Key Performance Indicators (KPIs)

1. **User Engagement Metrics**
   - Total verified users
   - Weekly/Monthly Active Users (WAU/MAU)
   - Engagement rates by time period
   - Platform usage distribution (Dashboard, Email, Android, iOS)
   - Daily activity trends

2. **Content Quality Metrics**
   - Average comment length
   - Tag usage rates
   - Custom tag adoption
   - Content feature engagement

3. **User Retention Analysis**
   - Active users (7 days, 30 days)
   - Dormant users (30-90 days)
   - Churned users (90+ days)
   - Retention percentages

4. **Business Intelligence**
   - Account level performance (Basic, Pro, Enterprise)
   - Daily/Monthly active users
   - User distribution analytics

5. **Platform Analytics**
   - Cross-platform usage patterns
   - Platform-specific engagement metrics
   - Multi-platform user identification

## Requirements

Install the required Python packages:

```bash
pip install plotly pandas kaleido python-dotenv requests
```

## Usage

### Generate and Email Report

Run the main script to generate a comprehensive report and email it:

```bash
python calculate-usage-stats.py
```

This will:
- Generate comprehensive analytics with charts
- Send a beautifully formatted HTML email report
- Include all KPIs and visualizations

### Generate Local Preview

To generate a local HTML file for preview without sending email:

```bash
python test-analytics.py
```

This creates `analytics_report.html` that you can open in your browser.

## Configuration

The script uses environment variables from the project's `.env` file:

- `MAILGUN_API_KEY` - Mailgun API key for sending emails
- `EMAIL_DOMAIN` - Email domain for Mailgun
- `NOREPLY_EMAIL` - Sender email address

The recipient email is currently hardcoded to `ryan@moodful.ca` in the script.

## Database Requirements

The script requires access to two databases:

1. **Main Database** (`../database.sqlite`)
   - Users table with account levels
   - User verification status

2. **Analytics Database** (`../analytics.sqlite`)
   - `mood_submissions` table with:
     - Submission timestamps
     - Platform sources
     - Comment lengths
     - Tag counts
     - Custom tag usage

## Report Sections

### 1. Executive Dashboard
- Key metrics at a glance
- Total users, active users, engagement rates
- Color-coded KPI cards

### 2. User Distribution
- Account level breakdown
- Visual pie chart
- User counts by tier

### 3. Engagement Metrics
- Platform usage statistics
- Activity trends over time
- Daily/weekly patterns

### 4. Content Quality
- Comment engagement rates
- Tag usage patterns
- Feature adoption metrics

### 5. Retention Analysis
- User lifecycle stages
- Churn analysis
- Retention visualizations

### 6. Business Metrics
- MAU/DAU calculations
- Account level performance
- Growth indicators

## Visual Features

- **Modern Design**: Professional styling with gradients and shadows
- **Interactive Charts**: Beautiful Plotly visualizations
- **Responsive Layout**: Works on desktop and mobile
- **Color Coding**: Meaningful colors for different metrics
- **Data Tables**: Clean, organized data presentation

## Customization

### Adding New Metrics

To add new KPIs:

1. Add a new method to the `MoodfulAnalytics` class
2. Include database queries for your metric
3. Generate visualizations if needed
4. Add the section to the HTML report in `generate_html_report()`

### Modifying Charts

Charts are generated using Plotly. You can:
- Change colors by modifying `marker_colors`
- Adjust chart types (bar, line, pie, etc.)
- Customize layouts and styling
- Add new chart types

### Email Customization

Modify the email sending in `send_analytics_email()`:
- Change recipient email
- Modify subject line
- Add attachments
- Include additional metadata

## Troubleshooting

### Common Issues

1. **Missing Dependencies**
   ```bash
   pip install plotly pandas kaleido
   ```

2. **Database Not Found**
   - Ensure database files exist in parent directory
   - Check file permissions

3. **Chart Generation Errors**
   - Verify Kaleido is properly installed
   - Check data format before chart creation

4. **Email Sending Failures**
   - Verify Mailgun credentials
   - Check internet connection
   - Validate email addresses

### Debug Mode

For debugging, you can:
- Use the test script to generate local reports
- Add print statements to track data flow
- Check database contents manually

## Scheduled Execution

To run automatically, add to crontab:

```bash
# Run daily at 9 AM
0 9 * * * cd /path/to/mood-api/scripts && python calculate-usage-stats.py

# Run weekly on Mondays at 9 AM
0 9 * * 1 cd /path/to/mood-api/scripts && python calculate-usage-stats.py
```

## Future Enhancements

Potential improvements:
- Interactive web dashboard
- Real-time metrics
- Automated alerts for anomalies
- Predictive analytics
- A/B testing metrics
- Cohort analysis
- Revenue analytics (for Pro users)

## Support

For issues or questions about the analytics system, check:
1. Database schema and connections
2. Required dependencies
3. Environment variable configuration
4. Log output for specific errors 