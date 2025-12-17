// utils/logManager.js
const moment = require('moment'); // Optional: for timestamps, or use Date()

class LogManager {
    
    /**
     * Formats and prints a log message.
     * Format: [TIMESTAMP] [TAG] [ID?] Message
     */
    static print(level, tag, message, id = null, error = null) {
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const idString = id ? `[${id}]` : '';
        const logString = `[${timestamp}] [${tag}]${idString} ${message}`;

        switch (level) {
            case 'ERROR':
                console.error(logString);
                if (error) console.error(error);
                break;
            case 'WARN':
                console.warn(logString);
                break;
            case 'DEBUG':
                // You can comment this out to silence debug logs easily if needed later
                console.log(logString);
                break;
            default: // INFO
                console.log(logString);
                break;
        }
    }

    static info(tag, message, id = null) {
        this.print('INFO', tag, message, id);
    }

    static debug(tag, message, id = null) {
        this.print('DEBUG', tag, message, id);
    }

    static warn(tag, message, id = null) {
        this.print('WARN', tag, message, id);
    }

    static error(tag, message, id = null, errorObject = null) {
        this.print('ERROR', tag, message, id, errorObject);
    }
}

module.exports = LogManager;