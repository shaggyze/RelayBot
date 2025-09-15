// utils/time.js

// The hour in UTC that the daily reset should happen.
// 19:00 UTC corresponds to 12:00 PM (Noon) in Las Vegas (PDT, UTC-7).
const RESET_HOUR_UTC = 19;

/**
 * Calculates the unique date string for the current rate-limit period.
 * A "day" is the 24-hour period between resets (e.g., 19:00 UTC to 18:59 UTC).
 * @returns {string} The date string in YYYY-MM-DD format for the current period.
 */
function getRateLimitDayString() {
    const now = new Date();
    // By subtracting the reset hour, we shift the "start of the day" from 00:00 UTC
    // to our desired reset time. For any time before 19:00 UTC, this will roll
    // the date back to the previous day, correctly grouping it with the previous period.
    const adjustedDate = new Date(now.getTime() - (RESET_HOUR_UTC * 60 * 60 * 1000));
    return adjustedDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

module.exports = { getRateLimitDayString, RESET_HOUR_UTC };