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
  showLevel?: boolean;
}

class UnifiedLogger {
  private logger: winston.Logger;
  private enableColors: boolean;
  private showLevel: boolean;

  constructor(options: LoggerOptions = {}) {
    this.enableColors = options.enableColors !== false;
    this.showLevel = options.showLevel !== false;

    // Create Winston logger with custom format and levels
    this.logger = winston.createLogger({
      level: options.level || 'info',
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        success: 3,
        debug: 4,
      },
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
    // If showLevel is false, return just the message
    if (!this.showLevel) {
      if (Array.isArray(message)) {
        return message.join('\n');
      }
      return message;
    }

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
   * Process multiple parameters and return the final message
   */
  private processParams(firstParam: string | string[], ...restParams: any[]): string | string[] {
    // If first parameter is an array, handle it line by line
    if (Array.isArray(firstParam)) {
      if (restParams.length === 0) {
        return firstParam;
      }

      // Convert rest parameters to string and append to each line
      const restString = restParams
        .map((param) => (typeof param === 'object' ? JSON.stringify(param) : String(param)))
        .join(' ');

      return firstParam.map((line) => `${line} ${restString}`);
    }

    // If first parameter is a string, concatenate with rest parameters
    const allParams = [firstParam, ...restParams];
    return allParams.map((param) => (typeof param === 'object' ? JSON.stringify(param) : String(param))).join(' ');
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
  error(firstParam: string | string[], ...restParams: any[]) {
    const message = this.processParams(firstParam, ...restParams);
    this.log('error', message);
  }

  /**
   * Log warning messages
   */
  warn(firstParam: string | string[], ...restParams: any[]) {
    const message = this.processParams(firstParam, ...restParams);
    this.log('warn', message);
  }

  /**
   * Log info messages
   */
  info(firstParam: string | string[], ...restParams: any[]) {
    const message = this.processParams(firstParam, ...restParams);
    this.log('info', message);
  }

  /**
   * Log debug messages
   */
  debug(firstParam: string | string[], ...restParams: any[]) {
    const message = this.processParams(firstParam, ...restParams);
    this.log('debug', message);
  }

  /**
   * Log success messages
   */
  success(firstParam: string | string[], ...restParams: any[]) {
    const message = this.processParams(firstParam, ...restParams);
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
const logger = UnifiedLogger.create({ showLevel: false });

export { logger, UnifiedLogger };
export type { LoggerOptions, LogLevel };
