/**
 * Migrations Module - Database Migration Detection and Validation
 * 
 * Exports all migration-related types, classes, and utilities.
 */

export * from './types.js';
export { 
  MigrationDetector, 
  migrationDetector,
  matchesMigrationPattern,
  getMigrationPathsForTool,
  getAllMigrationPatterns,
  getAllMigrationPaths,
  MIGRATION_SAFETY_PATTERNS,
} from './detector.js';
export { MigrationValidator, migrationValidator } from './validator.js';
