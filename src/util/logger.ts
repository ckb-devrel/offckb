import winston from 'winston';
import chalk from 'chalk';

// Define log levels with corresponding chalk colors
const levelColors = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.blue,
  debug: chalk.gray,
  success: chalk.green,
};

type LogLevel = keyof typeof levelColors;

interface LoggerOptions {
  level?: LogLevel;
  enableColors?: boolean;
}

class UnifiedLogger {
  private logger: winston.Logger;
  private enableColors: boolean;

  constructor(options: LoggerOptions = {}) {
    this.enableColors = options.enableColors !== false;

    // Create Winston logger with custom format
    this.logger = winston.createLogger({
      level: options.level || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ level, message, timestamp }) => {
          return this.formatMessage(level as LogLevel, message as string, timestamp as string);
        }),
      ),
      transports: [
        new winston.transports.Console({
          stderrLevels: ['error', 'warn'],
        }),
      ],
    });
  }

  /**
   * Format the message with appropriate colors and structure
   */
  private formatMessage(level: LogLevel, message: string, _timestamp?: string): string {
    if (!this.enableColors) {
      return `[${level.toUpperCase()}] ${message}`;
    }

    const colorFn = levelColors[level];
    const levelStr = colorFn(`[${level.toUpperCase()}]`);

    // Handle array messages (line-by-line output)
    if (Array.isArray(message)) {
      return message
        .map((line, index) => {
          const prefix = index === 0 ? levelStr : ' '.repeat(levelStr.length);
          return `${prefix} ${line}`;
        })
        .join('\n');
    }

    return `${levelStr} ${message}`;
  }

  /**
   * Log a message with the specified level
   */
  private log(level: LogLevel, message: string | string[]) {
    if (Array.isArray(message)) {
      message.forEach((line) => this.logger.log(level, line));
    } else {
      this.logger.log(level, message);
    }
  }

  /**
   * Log error messages
   */
  error(message: string | string[]) {
    this.log('error', message);
  }

  /**
   * Log warning messages
   */
  warn(message: string | string[]) {
    this.log('warn', message);
  }

  /**
   * Log info messages
   */
  info(message: string | string[]) {
    this.log('info', message);
  }

  /**
   * Log debug messages
   */
  debug(message: string | string[]) {
    this.log('debug', message);
  }

  /**
   * Log success messages
   */
  success(message: string | string[]) {
    this.log('success', message);
  }

  /**
   * Log a complete section with title and content
   */
  section(title: string, content: string | string[], level: LogLevel = 'info') {
    const formattedTitle = `=== ${title} ===`;

    if (Array.isArray(content)) {
      this.log(level, [formattedTitle, ...content, '']);
    } else {
      this.log(level, [formattedTitle, content, '']);
    }
  }

  /**
   * Log a list of items
   */
  list(title: string, items: string[], level: LogLevel = 'info') {
    const formattedItems = items.map((item, index) => `${index + 1}. ${item}`);
    this.section(title, formattedItems, level);
  }

  /**
   * Log a step-by-step process
   */
  steps(title: string, steps: string[], level: LogLevel = 'info') {
    this.list(title, steps, level);
  }

  /**
   * Create a new logger instance with specific configuration
   */
  static create(options: LoggerOptions = {}): UnifiedLogger {
    return new UnifiedLogger(options);
  }
}

// Create a default instance for global use
const logger = UnifiedLogger.create();

export { logger, UnifiedLogger };
export type { LoggerOptions, LogLevel };
