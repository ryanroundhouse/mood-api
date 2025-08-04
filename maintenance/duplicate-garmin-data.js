const { db } = require('../database');
const logger = require('../utils/logger');

/**
 * Script to duplicate all Garmin data from user ID 1 to user ID 5
 * This is for screenshot/demo purposes
 */

function duplicateGarminData() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Step 1: Update user 5's Garmin connection info
      db.run(`
        UPDATE users SET 
          garminConnected = 1,
          garminUserId = '5f436cb7-a5f8-446c-931d-9ed33b109726',
          garminAccessToken = (SELECT garminAccessToken FROM users WHERE id = 1),
          garminTokenSecret = (SELECT garminTokenSecret FROM users WHERE id = 1)
        WHERE id = 5
      `, function(err) {
        if (err) {
          logger.error('Error updating user 5 Garmin connection:', err);
          reject(err);
          return;
        }
        logger.info(`✅ Updated user 5 Garmin connection info (${this.changes} rows affected)`);
      });

      // Step 2: Copy all sleep summaries from user 1 to user 5
      db.run(`
        INSERT INTO sleep_summaries (
          userId, garminUserId, summaryId, calendarDate, startTimeInSeconds, 
          startTimeOffsetInSeconds, durationInHours, deepSleepDurationInHours,
          lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
          createdAt, updatedAt
        )
        SELECT 
          5 as userId, 
          '5f436cb7-a5f8-446c-931d-9ed33b109726' as garminUserId,
          'user5_' || summaryId as summaryId,
          calendarDate, startTimeInSeconds, startTimeOffsetInSeconds, 
          durationInHours, deepSleepDurationInHours, lightSleepDurationInHours,
          remSleepInHours, awakeDurationInHours, createdAt, updatedAt
        FROM sleep_summaries 
        WHERE userId = 1
      `, function(err) {
        if (err) {
          logger.error('Error copying sleep summaries:', err);
          reject(err);
          return;
        }
        logger.info(`✅ Copied ${this.changes} sleep summaries from user 1 to user 5`);
      });

      // Step 3: Copy all daily summaries from user 1 to user 5
      db.run(`
        INSERT INTO daily_summaries (
          userId, garminUserId, summaryId, calendarDate, steps, 
          distanceInMeters, activeTimeInHours, floorsClimbed,
          averageStressLevel, maxStressLevel, stressDurationInMinutes,
          createdAt, updatedAt
        )
        SELECT 
          5 as userId,
          '5f436cb7-a5f8-446c-931d-9ed33b109726' as garminUserId,
          'user5_' || summaryId as summaryId,
          calendarDate, steps, distanceInMeters, activeTimeInHours,
          floorsClimbed, averageStressLevel, maxStressLevel, 
          stressDurationInMinutes, createdAt, updatedAt
        FROM daily_summaries 
        WHERE userId = 1
      `, function(err) {
        if (err) {
          logger.error('Error copying daily summaries:', err);
          reject(err);
          return;
        }
        logger.info(`✅ Copied ${this.changes} daily summaries from user 1 to user 5`);
        
        // Final verification
        db.get(`
          SELECT 
            (SELECT COUNT(*) FROM sleep_summaries WHERE userId = 5) as sleep_count,
            (SELECT COUNT(*) FROM daily_summaries WHERE userId = 5) as daily_count
        `, (err, result) => {
          if (err) {
            logger.error('Error verifying copied data:', err);
            reject(err);
            return;
          }
          
          logger.info(`🎯 Verification: User 5 now has ${result.sleep_count} sleep summaries and ${result.daily_count} daily summaries`);
          resolve(result);
        });
      });
    });
  });
}

// Run the duplication
if (require.main === module) {
  logger.info('🔄 Starting Garmin data duplication from user 1 to user 5...');
  
  duplicateGarminData()
    .then((result) => {
      logger.info('✅ Successfully duplicated all Garmin data!');
      logger.info(`📊 Final counts - Sleep: ${result.sleep_count}, Daily: ${result.daily_count}`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Failed to duplicate Garmin data:', error);
      process.exit(1);
    });
}

module.exports = { duplicateGarminData }; 