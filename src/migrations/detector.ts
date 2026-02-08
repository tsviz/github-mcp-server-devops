/**
 * Migration Detector - Detects database migrations in repositories
 * 
 * Scans repositories for:
 * - Migration files (SQL, Python, Ruby, JS)
 * - Build tool configurations (Maven, Gradle, .NET, npm)
 * - Workflow commands that execute migrations
 */

import {
  MigrationTool,
  BuildSystem,
  DatabaseType,
  MigrationDetectionResult,
  MigrationFile,
  DetectedOperation,
  WorkflowMigrationInfo,
  BuildConfigInfo,
  BuildToolPattern,
} from './types.js';

// ============================================
// Migration Discovery Patterns (Regex-based)
// ============================================

// Flexible patterns that match common variations:
// - changelog, changelogs, changelog-v2, db_changelog
// - migration, migrations, db_migrations, migrations_v1
// - Different casing: Migrations, MIGRATIONS, migrations

const MIGRATION_PATH_PATTERNS: Record<MigrationTool, RegExp[]> = {
  flyway: [
    /^(?:src\/main\/resources\/)?(?:db[_-]?)?migrat(?:ion|ions?)(?:[_-]?v?\d+)?$/i,
    /^flyway\/migrat(?:ion|ions?)$/i,
    /^sql\/migrat(?:ion|ions?)$/i,
  ],
  liquibase: [
    /^(?:src\/main\/resources\/)?(?:db[_-]?)?changelog(?:s)?(?:[_-]?v?\d+(?:\.\d+)*)?$/i,
    /^liquibase\/changelog(?:s)?$/i,
  ],
  alembic: [
    /^alembic\/versions?$/i,
    /^migrat(?:ion|ions?)\/versions?$/i,
  ],
  prisma: [
    /^prisma\/migrat(?:ion|ions?)$/i,
  ],
  knex: [
    /^(?:db[_-]?)?migrat(?:ion|ions?)$/i,
  ],
  typeorm: [
    /^(?:src\/)?migrat(?:ion|ions?)$/i,
    /^(?:src\/)?database\/migrat(?:ion|ions?)$/i,
  ],
  sequelize: [
    /^(?:db[_-]?)?migrat(?:ion|ions?)$/i,
    /^(?:src\/)?database\/migrat(?:ion|ions?)$/i,
  ],
  rails: [
    /^db\/migrate$/i,
  ],
  django: [
    /^[^/]+\/migrat(?:ion|ions?)$/i,  // app_name/migrations
  ],
  efcore: [
    /^(?:(?:src|app|web|api)\/)?(?:[^/]+\/)?Migrat(?:ion|ions?)$/i,
    /^(?:Data|Infrastructure|Persistence)\/Migrat(?:ion|ions?)$/i,
  ],
  dbup: [
    /^(?:Db)?Scripts?$/i,
    /^Database\/Scripts?$/i,
    /^(?:sql|db)[_-]?scripts?$/i,
  ],
  goose: [
    /^(?:db[_-]?)?migrat(?:ion|ions?)$/i,
  ],
  unknown: [],
};

// Fallback explicit paths for common cases (used when patterns don't match)
const MIGRATION_PATHS: Record<MigrationTool, string[]> = {
  flyway: [
    'src/main/resources/db/migration',
    'db/migration',
    'flyway/migrations',
    'sql/migrations',
  ],
  liquibase: [
    'src/main/resources/db/changelog',
    'db/changelog',
    'liquibase/changelog',
  ],
  alembic: [
    'alembic/versions',
    'migrations/versions',
  ],
  prisma: [
    'prisma/migrations',
  ],
  knex: [
    'migrations',
    'db/migrations',
  ],
  typeorm: [
    'src/migrations',
    'migrations',
  ],
  sequelize: [
    'migrations',
    'db/migrations',
  ],
  rails: [
    'db/migrate',
  ],
  django: [
    '*/migrations',
  ],
  efcore: [
    'Migrations',
    'Data/Migrations',
  ],
  dbup: [
    'Scripts',
    'DbScripts',
    'Database/Scripts',
  ],
  goose: [
    'migrations',
    'db/migrations',
  ],
  unknown: [],
};

// ============================================
// Path Matching Utilities
// ============================================

/**
 * Check if a path matches any migration pattern for a given tool
 */
export function matchesMigrationPattern(path: string, tool?: MigrationTool): { matches: boolean; tool: MigrationTool | null } {
  const toolsToCheck = tool ? [tool] : Object.keys(MIGRATION_PATH_PATTERNS) as MigrationTool[];
  
  for (const t of toolsToCheck) {
    const patterns = MIGRATION_PATH_PATTERNS[t];
    if (!patterns) continue;
    
    for (const pattern of patterns) {
      if (pattern.test(path)) {
        return { matches: true, tool: t };
      }
    }
  }
  
  return { matches: false, tool: null };
}

/**
 * Get all possible migration paths to search for a tool
 * Returns both pattern-based suggestions and explicit fallback paths
 */
export function getMigrationPathsForTool(tool: MigrationTool): { patterns: RegExp[]; explicitPaths: string[] } {
  return {
    patterns: MIGRATION_PATH_PATTERNS[tool] || [],
    explicitPaths: MIGRATION_PATHS[tool] || [],
  };
}

/**
 * Get all migration path patterns for discovery
 * Used when scanning a repo without knowing the tool
 */
export function getAllMigrationPatterns(): RegExp[] {
  const allPatterns: RegExp[] = [];
  for (const tool of Object.keys(MIGRATION_PATH_PATTERNS) as MigrationTool[]) {
    allPatterns.push(...(MIGRATION_PATH_PATTERNS[tool] || []));
  }
  return allPatterns;
}

/**
 * Get all explicit migration paths for discovery
 */
export function getAllMigrationPaths(): string[] {
  const allPaths = new Set<string>();
  for (const tool of Object.keys(MIGRATION_PATHS) as MigrationTool[]) {
    for (const path of MIGRATION_PATHS[tool]) {
      allPaths.add(path);
    }
  }
  return Array.from(allPaths);
}

// ============================================
// Build Tool Patterns
// ============================================

const BUILD_TOOL_PATTERNS: BuildToolPattern[] = [
  // Maven + Flyway
  {
    tool: 'flyway',
    buildSystem: 'maven',
    configFiles: ['pom.xml'],
    pluginPatterns: [
      {
        file: 'pom.xml',
        pattern: /<groupId>org\.flywaydb<\/groupId>/i,
        groupIdPattern: 'org.flywaydb',
        artifactIdPattern: 'flyway-maven-plugin',
      },
    ],
    commandPatterns: [
      { pattern: /mvn\s+.*flyway:migrate/i, buildContext: ['maven', 'mvn', 'mvnw'] },
      { pattern: /\.\/mvnw\s+.*flyway:migrate/i, buildContext: ['maven'] },
      { pattern: /-Dflyway\.(url|user|password)/i, buildContext: ['maven'] },
    ],
    migrationPaths: MIGRATION_PATHS.flyway,
  },
  // Maven + Liquibase
  {
    tool: 'liquibase',
    buildSystem: 'maven',
    configFiles: ['pom.xml'],
    pluginPatterns: [
      {
        file: 'pom.xml',
        pattern: /<groupId>org\.liquibase<\/groupId>/i,
        groupIdPattern: 'org.liquibase',
        artifactIdPattern: 'liquibase-maven-plugin',
      },
    ],
    commandPatterns: [
      { pattern: /mvn\s+.*liquibase:update/i, buildContext: ['maven'] },
      { pattern: /mvn\s+.*liquibase:rollback/i, buildContext: ['maven'] },
    ],
    migrationPaths: MIGRATION_PATHS.liquibase,
  },
  // Gradle + Flyway
  {
    tool: 'flyway',
    buildSystem: 'gradle',
    configFiles: ['build.gradle', 'build.gradle.kts'],
    pluginPatterns: [
      { file: 'build.gradle', pattern: /id\s+['"]org\.flywaydb\.flyway['"]/i },
      { file: 'build.gradle.kts', pattern: /id\s*\(\s*["']org\.flywaydb\.flyway["']\s*\)/i },
      { file: 'build.gradle', pattern: /plugins\s*\{[^}]*flyway/i },
    ],
    commandPatterns: [
      { pattern: /gradle\s+.*flywayMigrate/i, buildContext: ['gradle', 'gradlew'] },
      { pattern: /\.\/gradlew\s+.*flywayMigrate/i, buildContext: ['gradle'] },
    ],
    migrationPaths: MIGRATION_PATHS.flyway,
  },
  // Gradle + Liquibase
  {
    tool: 'liquibase',
    buildSystem: 'gradle',
    configFiles: ['build.gradle', 'build.gradle.kts'],
    pluginPatterns: [
      { file: 'build.gradle', pattern: /id\s+['"]org\.liquibase['"]/i },
      { file: 'build.gradle.kts', pattern: /id\s*\(\s*["']org\.liquibase["']\s*\)/i },
    ],
    commandPatterns: [
      { pattern: /gradle\s+.*update/i, buildContext: ['gradle'] },
    ],
    migrationPaths: MIGRATION_PATHS.liquibase,
  },
  // .NET EF Core
  {
    tool: 'efcore',
    buildSystem: 'dotnet',
    configFiles: ['*.csproj', '*.fsproj'],
    pluginPatterns: [
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore\.Design/i },
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore\.Tools/i },
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore\.SqlServer/i },
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore\.Sqlite/i },
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore\.PostgreSQL/i },
      { file: '*.csproj', pattern: /Npgsql\.EntityFrameworkCore/i },
      { file: '*.csproj', pattern: /Pomelo\.EntityFrameworkCore/i },
      { file: '*.csproj', pattern: /Microsoft\.EntityFrameworkCore[^<]*Version/i },
    ],
    commandPatterns: [
      { pattern: /dotnet\s+ef\s+database\s+update/i, buildContext: ['dotnet'] },
      { pattern: /dotnet\s+ef\s+migrations\s+script/i, buildContext: ['dotnet'] },
      { pattern: /dotnet[\s-]+ef\s+/i, buildContext: ['dotnet'] },
      { pattern: /Update-Database/i, buildContext: ['powershell', 'dotnet'] },
    ],
    migrationPaths: MIGRATION_PATHS.efcore,
  },
  // .NET DbUp
  {
    tool: 'dbup',
    buildSystem: 'dotnet',
    configFiles: ['*.csproj'],
    pluginPatterns: [
      { file: '*.csproj', pattern: /DbUp/i },
      { file: '*.csproj', pattern: /dbup-sqlserver|dbup-postgresql|dbup-mysql/i },
    ],
    commandPatterns: [],
    migrationPaths: MIGRATION_PATHS.dbup,
  },
  // npm + Prisma
  {
    tool: 'prisma',
    buildSystem: 'npm',
    configFiles: ['package.json'],
    pluginPatterns: [
      { file: 'package.json', pattern: /"prisma"\s*:/i },
      { file: 'package.json', pattern: /"@prisma\/client"\s*:/i },
    ],
    commandPatterns: [
      { pattern: /npx\s+prisma\s+migrate\s+deploy/i, buildContext: ['npm', 'node'] },
      { pattern: /prisma\s+migrate\s+deploy/i, buildContext: ['npm', 'node'] },
    ],
    migrationPaths: MIGRATION_PATHS.prisma,
  },
  // npm + Knex
  {
    tool: 'knex',
    buildSystem: 'npm',
    configFiles: ['package.json'],
    pluginPatterns: [
      { file: 'package.json', pattern: /"knex"\s*:/i },
    ],
    commandPatterns: [
      { pattern: /npx\s+knex\s+migrate:latest/i, buildContext: ['npm', 'node'] },
      { pattern: /knex\s+migrate:latest/i, buildContext: ['npm', 'node'] },
    ],
    migrationPaths: MIGRATION_PATHS.knex,
  },
  // npm + TypeORM
  {
    tool: 'typeorm',
    buildSystem: 'npm',
    configFiles: ['package.json'],
    pluginPatterns: [
      { file: 'package.json', pattern: /"typeorm"\s*:/i },
    ],
    commandPatterns: [
      { pattern: /typeorm\s+migration:run/i, buildContext: ['npm', 'node'] },
      { pattern: /npx\s+typeorm\s+migration:run/i, buildContext: ['npm', 'node'] },
    ],
    migrationPaths: MIGRATION_PATHS.typeorm,
  },
  // npm + Sequelize
  {
    tool: 'sequelize',
    buildSystem: 'npm',
    configFiles: ['package.json'],
    pluginPatterns: [
      { file: 'package.json', pattern: /"sequelize-cli"\s*:/i },
    ],
    commandPatterns: [
      { pattern: /npx\s+sequelize-cli\s+db:migrate/i, buildContext: ['npm', 'node'] },
      { pattern: /sequelize\s+db:migrate/i, buildContext: ['npm', 'node'] },
    ],
    migrationPaths: MIGRATION_PATHS.sequelize,
  },
  // Ruby + Rails
  {
    tool: 'rails',
    buildSystem: 'bundler',
    configFiles: ['Gemfile'],
    pluginPatterns: [
      { file: 'Gemfile', pattern: /gem\s+['"]rails['"]/i },
      { file: 'Gemfile', pattern: /gem\s+['"]activerecord['"]/i },
    ],
    commandPatterns: [
      { pattern: /rake\s+db:migrate/i, buildContext: ['ruby', 'rails'] },
      { pattern: /rails\s+db:migrate/i, buildContext: ['ruby', 'rails'] },
      { pattern: /bundle\s+exec\s+rake\s+db:migrate/i, buildContext: ['ruby', 'bundler'] },
    ],
    migrationPaths: MIGRATION_PATHS.rails,
  },
  // Python + Alembic
  {
    tool: 'alembic',
    buildSystem: 'pip',
    configFiles: ['requirements.txt', 'pyproject.toml', 'setup.py'],
    pluginPatterns: [
      { file: 'requirements.txt', pattern: /alembic/i },
      { file: 'pyproject.toml', pattern: /alembic/i },
    ],
    commandPatterns: [
      { pattern: /alembic\s+upgrade\s+head/i, buildContext: ['python', 'pip'] },
      { pattern: /alembic\s+upgrade/i, buildContext: ['python'] },
    ],
    migrationPaths: MIGRATION_PATHS.alembic,
  },
  // Python + Django
  {
    tool: 'django',
    buildSystem: 'pip',
    configFiles: ['requirements.txt', 'pyproject.toml', 'manage.py'],
    pluginPatterns: [
      { file: 'requirements.txt', pattern: /django/i },
      { file: 'pyproject.toml', pattern: /django/i },
    ],
    commandPatterns: [
      { pattern: /python\s+manage\.py\s+migrate/i, buildContext: ['python', 'django'] },
      { pattern: /django-admin\s+migrate/i, buildContext: ['python', 'django'] },
    ],
    migrationPaths: MIGRATION_PATHS.django,
  },
  // Go + Goose
  {
    tool: 'goose',
    buildSystem: 'go',
    configFiles: ['go.mod'],
    pluginPatterns: [
      { file: 'go.mod', pattern: /pressly\/goose/i },
    ],
    commandPatterns: [
      { pattern: /goose\s+up/i, buildContext: ['go'] },
      { pattern: /goose\s+.*up/i, buildContext: ['go'] },
    ],
    migrationPaths: MIGRATION_PATHS.goose,
  },
];

// ============================================
// Workflow Migration Command Patterns
// ============================================

interface WorkflowCommandPattern {
  tool: MigrationTool;
  pattern: RegExp;
  stage: 'pre-deploy' | 'deploy' | 'post-deploy' | 'standalone';
}

const WORKFLOW_COMMAND_PATTERNS: WorkflowCommandPattern[] = [
  // Flyway
  { tool: 'flyway', pattern: /flyway\s+(migrate|repair|validate|info)/i, stage: 'pre-deploy' },
  { tool: 'flyway', pattern: /flyway:migrate/i, stage: 'pre-deploy' },
  { tool: 'flyway', pattern: /flywayMigrate/i, stage: 'pre-deploy' },
  
  // Liquibase
  { tool: 'liquibase', pattern: /liquibase\s+(update|rollback|diff)/i, stage: 'pre-deploy' },
  { tool: 'liquibase', pattern: /liquibase:update/i, stage: 'pre-deploy' },
  
  // EF Core
  { tool: 'efcore', pattern: /dotnet\s+ef\s+database\s+update/i, stage: 'pre-deploy' },
  { tool: 'efcore', pattern: /dotnet\s+ef\s+migrations\s+script/i, stage: 'pre-deploy' },
  { tool: 'efcore', pattern: /dotnet[\s-]+ef[\s-]+database[\s-]+update/i, stage: 'pre-deploy' },
  { tool: 'efcore', pattern: /dotnet[\s-]+ef[\s-]+migrations/i, stage: 'pre-deploy' },
  { tool: 'efcore', pattern: /Update-Database/i, stage: 'pre-deploy' },
  { tool: 'efcore', pattern: /EntityFrameworkCore.*[Mm]igrat/i, stage: 'pre-deploy' },
  
  // Prisma
  { tool: 'prisma', pattern: /prisma\s+migrate\s+deploy/i, stage: 'deploy' },
  { tool: 'prisma', pattern: /prisma\s+db\s+push/i, stage: 'deploy' },
  
  // Knex
  { tool: 'knex', pattern: /knex\s+migrate:latest/i, stage: 'deploy' },
  { tool: 'knex', pattern: /knex\s+migrate:rollback/i, stage: 'deploy' },
  
  // Rails
  { tool: 'rails', pattern: /rake\s+db:migrate/i, stage: 'deploy' },
  { tool: 'rails', pattern: /rails\s+db:migrate/i, stage: 'deploy' },
  
  // Django
  { tool: 'django', pattern: /manage\.py\s+migrate/i, stage: 'deploy' },
  { tool: 'django', pattern: /django-admin\s+migrate/i, stage: 'deploy' },
  
  // Alembic
  { tool: 'alembic', pattern: /alembic\s+upgrade/i, stage: 'pre-deploy' },
  
  // TypeORM
  { tool: 'typeorm', pattern: /typeorm\s+migration:run/i, stage: 'deploy' },
  
  // Sequelize
  { tool: 'sequelize', pattern: /sequelize(-cli)?\s+db:migrate/i, stage: 'deploy' },
  
  // Goose
  { tool: 'goose', pattern: /goose\s+(up|down)/i, stage: 'pre-deploy' },
];

// ============================================
// Build-Integrated Migration Patterns
// Migrations that run as part of Maven/Gradle/npm build lifecycle
// ============================================

interface BuildIntegratedPattern {
  tool: MigrationTool;
  buildSystem: BuildSystem;
  workflowPattern: RegExp;
  description: string;
}

const BUILD_INTEGRATED_PATTERNS: BuildIntegratedPattern[] = [
  // Maven lifecycle commands that may trigger Liquibase/Flyway via plugin bindings
  // More flexible patterns to catch common CI variations:
  // - mvn clean package, mvn -B package, mvn -DskipTests package
  // - ./mvnw package, ./mvnw -B clean verify
  // - run: mvn package (multiline YAML)
  { tool: 'liquibase', buildSystem: 'maven', workflowPattern: /(?:^|\s|run:\s*['"]?)(?:\.\/)?mvn(?:w)?\s+[^\n]*(?:package|verify|install|deploy|test|spring-boot:run|compile|build)/im, description: 'Maven lifecycle (may trigger Liquibase)' },
  { tool: 'flyway', buildSystem: 'maven', workflowPattern: /(?:^|\s|run:\s*['"]?)(?:\.\/)?mvn(?:w)?\s+[^\n]*(?:package|verify|install|deploy|test|spring-boot:run|compile|build)/im, description: 'Maven lifecycle (may trigger Flyway)' },
  
  // Gradle lifecycle commands
  { tool: 'liquibase', buildSystem: 'gradle', workflowPattern: /(?:^|\s|run:\s*['"]?)(?:\.\/)?gradle(?:w)?\s+[^\n]*(?:build|bootRun|assemble|test)/im, description: 'Gradle build (may trigger Liquibase)' },
  { tool: 'flyway', buildSystem: 'gradle', workflowPattern: /(?:^|\s|run:\s*['"]?)(?:\.\/)?gradle(?:w)?\s+[^\n]*(?:build|bootRun|assemble|test)/im, description: 'Gradle build (may trigger Flyway)' },
  
  // .NET build/run commands that trigger EF Core migrations at startup
  { tool: 'efcore', buildSystem: 'dotnet', workflowPattern: /(?:^|\s|run:\s*['"]?)dotnet\s+(?:run|publish|build|test)/im, description: '.NET build/run (may trigger EF Core at startup)' },
  
  // npm/node commands that may trigger migrations
  { tool: 'prisma', buildSystem: 'npm', workflowPattern: /(?:^|\s|run:\s*['"]?)npm\s+(?:run\s+)?(?:build|start|dev|test)/im, description: 'npm build (may trigger Prisma)' },
  { tool: 'knex', buildSystem: 'npm', workflowPattern: /(?:^|\s|run:\s*['"]?)npm\s+(?:run\s+)?(?:build|start|dev|test)/im, description: 'npm build (may trigger Knex)' },
  { tool: 'typeorm', buildSystem: 'npm', workflowPattern: /(?:^|\s|run:\s*['"]?)npm\s+(?:run\s+)?(?:build|start|dev|test)/im, description: 'npm build (may trigger TypeORM)' },
  
  // Docker run commands that start the application (runtime migrations trigger on startup)
  { tool: 'liquibase', buildSystem: 'maven', workflowPattern: /docker\s+(?:run|compose\s+up)/im, description: 'Docker run (may trigger migrations at startup)' },
  { tool: 'flyway', buildSystem: 'maven', workflowPattern: /docker\s+(?:run|compose\s+up)/im, description: 'Docker run (may trigger migrations at startup)' },
  { tool: 'efcore', buildSystem: 'dotnet', workflowPattern: /docker\s+(?:run|compose\s+up)/im, description: 'Docker run (may trigger migrations at startup)' },
  
  // Kubernetes deployment (app will run migrations on startup)
  { tool: 'liquibase', buildSystem: 'maven', workflowPattern: /kubectl\s+(?:apply|rollout)/im, description: 'Kubernetes deployment (migrations run on app startup)' },
  { tool: 'flyway', buildSystem: 'maven', workflowPattern: /kubectl\s+(?:apply|rollout)/im, description: 'Kubernetes deployment (migrations run on app startup)' },
  { tool: 'efcore', buildSystem: 'dotnet', workflowPattern: /kubectl\s+(?:apply|rollout)/im, description: 'Kubernetes deployment (migrations run on app startup)' },
];

// ============================================
// Runtime Migration Detection (Spring Boot, etc.)
// Patterns in build configs indicating auto-migration at startup
// ============================================

interface RuntimeMigrationPattern {
  tool: MigrationTool;
  configFile: string;
  pattern: RegExp;
  description: string;
}

const RUNTIME_MIGRATION_PATTERNS: RuntimeMigrationPattern[] = [
  // Spring Boot + Liquibase (auto-runs on startup)
  // Check for liquibase-core presence (Spring Boot auto-configures if found)
  { tool: 'liquibase', configFile: 'pom.xml', pattern: /liquibase-core/i, description: 'Spring Boot with Liquibase (runs on app startup)' },
  { tool: 'liquibase', configFile: 'pom.xml', pattern: /org\.liquibase/i, description: 'Liquibase dependency detected' },
  { tool: 'liquibase', configFile: 'build.gradle', pattern: /liquibase/i, description: 'Spring Boot with Liquibase (runs on app startup)' },
  
  // Spring Boot + Flyway (auto-runs on startup)
  { tool: 'flyway', configFile: 'pom.xml', pattern: /flyway-core/i, description: 'Spring Boot with Flyway (runs on app startup)' },
  { tool: 'flyway', configFile: 'pom.xml', pattern: /org\.flywaydb/i, description: 'Flyway dependency detected' },
  { tool: 'flyway', configFile: 'build.gradle', pattern: /flyway/i, description: 'Spring Boot with Flyway (runs on app startup)' },
  
  // Liquibase Maven plugin with execution bindings
  { tool: 'liquibase', configFile: 'pom.xml', pattern: /liquibase-maven-plugin/i, description: 'Liquibase Maven plugin' },
  
  // Flyway Maven plugin with execution bindings
  { tool: 'flyway', configFile: 'pom.xml', pattern: /flyway-maven-plugin/i, description: 'Flyway Maven plugin' },
  
  // EF Core with migrations applied at startup
  { tool: 'efcore', configFile: '*.cs', pattern: /Database\.Migrate\(\)/i, description: 'EF Core Database.Migrate() called at startup' },
  { tool: 'efcore', configFile: 'Program.cs', pattern: /\.Migrate\(\)/i, description: 'EF Core migration at app startup' },
  { tool: 'efcore', configFile: '*.csproj', pattern: /EntityFrameworkCore/i, description: 'EF Core detected' },
  
  // Rails schema load on start
  { tool: 'rails', configFile: 'config/database.yml', pattern: /schema_search_path/i, description: 'Rails database configuration' },
  
  // Django auto-migrate
  { tool: 'django', configFile: 'manage.py', pattern: /execute_from_command_line/i, description: 'Django management commands' },
];

// Export for external use
export { BUILD_INTEGRATED_PATTERNS, RUNTIME_MIGRATION_PATTERNS };

// ============================================
// Migration Safety Patterns (CI/CD Best Practices)
// ============================================

interface MigrationSafetyPattern {
  check: 'validation' | 'backup' | 'dry-run' | 'approval' | 'separate-stage';
  pattern: RegExp;
  tool?: MigrationTool;
  description: string;
}

const VALIDATION_PATTERNS: MigrationSafetyPattern[] = [
  // Flyway validation
  { check: 'validation', pattern: /flyway\s+validate/i, tool: 'flyway', description: 'Flyway schema validation' },
  { check: 'validation', pattern: /flyway:validate/i, tool: 'flyway', description: 'Flyway Maven validate goal' },
  { check: 'validation', pattern: /flywayValidate/i, tool: 'flyway', description: 'Flyway Gradle validate task' },
  
  // Liquibase validation
  { check: 'validation', pattern: /liquibase\s+validate/i, tool: 'liquibase', description: 'Liquibase changelog validation' },
  { check: 'validation', pattern: /liquibase:validate/i, tool: 'liquibase', description: 'Liquibase Maven validate' },
  { check: 'validation', pattern: /liquibase\s+diff/i, tool: 'liquibase', description: 'Liquibase diff check' },
  
  // EF Core validation
  { check: 'validation', pattern: /dotnet\s+ef\s+migrations\s+list/i, tool: 'efcore', description: 'EF Core migrations list' },
  { check: 'validation', pattern: /dotnet\s+ef\s+database\s+.*--dry-run/i, tool: 'efcore', description: 'EF Core dry-run' },
  
  // Prisma validation
  { check: 'validation', pattern: /prisma\s+validate/i, tool: 'prisma', description: 'Prisma schema validation' },
  { check: 'validation', pattern: /prisma\s+migrate\s+status/i, tool: 'prisma', description: 'Prisma migration status check' },
  
  // Alembic validation
  { check: 'validation', pattern: /alembic\s+check/i, tool: 'alembic', description: 'Alembic migration check' },
  { check: 'validation', pattern: /alembic\s+current/i, tool: 'alembic', description: 'Alembic current version check' },
  
  // Rails validation
  { check: 'validation', pattern: /rake\s+db:migrate:status/i, tool: 'rails', description: 'Rails migration status' },
  { check: 'validation', pattern: /rails\s+db:migrate:status/i, tool: 'rails', description: 'Rails migration status' },
];

const BACKUP_PATTERNS: MigrationSafetyPattern[] = [
  // PostgreSQL backups
  { check: 'backup', pattern: /pg_dump/i, description: 'PostgreSQL database dump' },
  { check: 'backup', pattern: /pg_dumpall/i, description: 'PostgreSQL cluster dump' },
  { check: 'backup', pattern: /PGPASSWORD.*pg_dump/i, description: 'PostgreSQL backup with credentials' },
  
  // MySQL backups
  { check: 'backup', pattern: /mysqldump/i, description: 'MySQL database dump' },
  { check: 'backup', pattern: /mysqlpump/i, description: 'MySQL parallel dump' },
  
  // SQL Server backups
  { check: 'backup', pattern: /BACKUP\s+DATABASE/i, description: 'SQL Server backup' },
  { check: 'backup', pattern: /SqlPackage.*\/Action:Export/i, description: 'SQL Server BACPAC export' },
  
  // Cloud provider snapshots
  { check: 'backup', pattern: /aws\s+rds\s+create-db-snapshot/i, description: 'AWS RDS snapshot' },
  { check: 'backup', pattern: /az\s+sql\s+db\s+.*backup/i, description: 'Azure SQL backup' },
  { check: 'backup', pattern: /gcloud\s+sql\s+backups\s+create/i, description: 'GCP Cloud SQL backup' },
  
  // Generic backup indicators
  { check: 'backup', pattern: /database.*backup/i, description: 'Database backup step' },
  { check: 'backup', pattern: /backup.*database/i, description: 'Database backup step' },
  { check: 'backup', pattern: /create.*snapshot/i, description: 'Snapshot creation' },
];

const DRY_RUN_PATTERNS: MigrationSafetyPattern[] = [
  // Flyway dry-run/info
  { check: 'dry-run', pattern: /flyway\s+info/i, tool: 'flyway', description: 'Flyway migration info' },
  { check: 'dry-run', pattern: /flyway:info/i, tool: 'flyway', description: 'Flyway Maven info goal' },
  
  // Liquibase preview
  { check: 'dry-run', pattern: /liquibase\s+updateSQL/i, tool: 'liquibase', description: 'Liquibase SQL preview' },
  { check: 'dry-run', pattern: /liquibase:updateSQL/i, tool: 'liquibase', description: 'Liquibase Maven SQL preview' },
  { check: 'dry-run', pattern: /liquibase\s+--dry-run/i, tool: 'liquibase', description: 'Liquibase dry-run' },
  
  // EF Core script generation
  { check: 'dry-run', pattern: /dotnet\s+ef\s+migrations\s+script/i, tool: 'efcore', description: 'EF Core script generation' },
  { check: 'dry-run', pattern: /Script-Migration/i, tool: 'efcore', description: 'EF Core PowerShell script' },
  
  // Prisma preview
  { check: 'dry-run', pattern: /prisma\s+migrate\s+diff/i, tool: 'prisma', description: 'Prisma migration diff' },
  
  // Django preview
  { check: 'dry-run', pattern: /manage\.py\s+sqlmigrate/i, tool: 'django', description: 'Django SQL preview' },
  { check: 'dry-run', pattern: /manage\.py\s+showmigrations/i, tool: 'django', description: 'Django migration list' },
  
  // Alembic preview
  { check: 'dry-run', pattern: /alembic\s+upgrade.*--sql/i, tool: 'alembic', description: 'Alembic SQL preview' },
];

const APPROVAL_PATTERNS: MigrationSafetyPattern[] = [
  // GitHub environment
  { check: 'approval', pattern: /environment:\s*\w+/i, description: 'GitHub environment specified' },
  
  // Manual approval actions
  { check: 'approval', pattern: /trstringer\/manual-approval/i, description: 'Manual approval action' },
  { check: 'approval', pattern: /hmarr\/auto-approve-action/i, description: 'Auto-approve action (review needed)' },
  { check: 'approval', pattern: /actions\/github-script.*approve/i, description: 'Custom approval script' },
  
  // Workflow dispatch (manual trigger)
  { check: 'approval', pattern: /workflow_dispatch/i, description: 'Manual workflow trigger' },
  
  // Wait/gate patterns
  { check: 'approval', pattern: /wait[-_]for[-_]approval/i, description: 'Approval gate' },
  { check: 'approval', pattern: /needs:\s*\[?.*approval/i, description: 'Depends on approval job' },
];

// Export safety patterns for external use
export const MIGRATION_SAFETY_PATTERNS = {
  validation: VALIDATION_PATTERNS,
  backup: BACKUP_PATTERNS,
  dryRun: DRY_RUN_PATTERNS,
  approval: APPROVAL_PATTERNS,
};

// ============================================
// SQL Operation Detection Patterns
// ============================================

interface SQLOperationPattern {
  type: DetectedOperation['type'];
  pattern: RegExp;
  riskLevel: DetectedOperation['riskLevel'];
  extractTarget: (match: RegExpMatchArray) => string;
}

const SQL_OPERATION_PATTERNS: SQLOperationPattern[] = [
  // CREATE operations
  {
    type: 'create',
    pattern: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'low',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'create',
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"']?\w+[`"']?)/gi,
    riskLevel: 'medium',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  
  // ALTER operations
  {
    type: 'alter',
    pattern: /ALTER\s+TABLE\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)\s+ADD\s+COLUMN/gi,
    riskLevel: 'low',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'alter',
    pattern: /ALTER\s+TABLE\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)\s+DROP\s+COLUMN/gi,
    riskLevel: 'high',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'alter',
    pattern: /ALTER\s+TABLE\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)\s+(?:ALTER|MODIFY)\s+COLUMN/gi,
    riskLevel: 'medium',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'alter',
    pattern: /ALTER\s+TABLE\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)\s+ADD\s+CONSTRAINT/gi,
    riskLevel: 'medium',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  
  // DROP operations
  {
    type: 'drop',
    pattern: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'critical',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'drop',
    pattern: /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([`"']?\w+[`"']?)/gi,
    riskLevel: 'medium',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'drop',
    pattern: /DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?([`"']?\w+[`"']?)/gi,
    riskLevel: 'critical',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'drop',
    pattern: /DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?([`"']?\w+[`"']?)/gi,
    riskLevel: 'critical',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  
  // DML operations
  {
    type: 'insert',
    pattern: /INSERT\s+INTO\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'low',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'update',
    pattern: /UPDATE\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)\s+SET/gi,
    riskLevel: 'medium',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'delete',
    pattern: /DELETE\s+FROM\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'high',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  
  // GRANT operations
  {
    type: 'grant',
    pattern: /GRANT\s+.*\s+ON\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'critical',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
  {
    type: 'grant',
    pattern: /REVOKE\s+.*\s+ON\s+([`"']?\w+[`"']?(?:\.[`"']?\w+[`"']?)?)/gi,
    riskLevel: 'critical',
    extractTarget: (m) => m[1]?.replace(/[`"']/g, '') || 'unknown',
  },
];

// ============================================
// Migration Detector Class
// ============================================

export class MigrationDetector {
  /**
   * Detect migration tool from build configuration content
   */
  detectMigrationToolFromBuildConfig(
    configContent: string,
    configFile: string
  ): { tool: MigrationTool; buildSystem: BuildSystem; pluginVersion: string | null; migrationPaths: string[] } | null {
    for (const pattern of BUILD_TOOL_PATTERNS) {
      for (const pluginPattern of pattern.pluginPatterns) {
        // Check if this pattern applies to the config file
        if (this.matchesConfigFile(configFile, pluginPattern.file)) {
          if (pluginPattern.pattern.test(configContent)) {
            const version = this.extractPluginVersion(configContent, pattern.tool);
            return {
              tool: pattern.tool,
              buildSystem: pattern.buildSystem,
              pluginVersion: version,
              migrationPaths: pattern.migrationPaths || MIGRATION_PATHS[pattern.tool] || [],
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Detect migration commands in workflow content
   */
  detectMigrationInWorkflow(workflowContent: string): WorkflowMigrationInfo[] {
    const results: WorkflowMigrationInfo[] = [];
    
    for (const cmdPattern of WORKFLOW_COMMAND_PATTERNS) {
      const matches = workflowContent.matchAll(new RegExp(cmdPattern.pattern.source, 'gi'));
      for (const match of matches) {
        // Try to extract job and step context
        const context = this.extractWorkflowContext(workflowContent, match.index || 0);
        
        results.push({
          workflowPath: '',  // To be filled by caller
          jobName: context.jobName,
          stepName: context.stepName,
          command: match[0],
          stage: cmdPattern.stage,
          hasApprovalGate: this.detectApprovalGate(workflowContent),
          environment: context.environment,
        });
      }
    }
    
    return results;
  }

  /**
   * Parse SQL content to detect operations
   */
  detectSQLOperations(sqlContent: string): DetectedOperation[] {
    const operations: DetectedOperation[] = [];
    const lines = sqlContent.split('\n');
    
    for (const pattern of SQL_OPERATION_PATTERNS) {
      let match;
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      
      while ((match = regex.exec(sqlContent)) !== null) {
        const lineNumber = this.getLineNumber(sqlContent, match.index);
        const statement = this.extractStatement(sqlContent, match.index);
        
        operations.push({
          type: pattern.type,
          target: pattern.extractTarget(match),
          line: lineNumber,
          statement: statement,
          riskLevel: pattern.riskLevel,
        });
      }
    }
    
    // Sort by line number
    operations.sort((a, b) => a.line - b.line);
    
    return operations;
  }

  /**
   * Analyze migration file naming to extract version and description
   */
  parseMigrationFileName(fileName: string, tool: MigrationTool): { version: string | null; description: string | null } {
    const patterns: Record<string, RegExp> = {
      // Flyway: V1.0.0__description.sql or V20240115143022__description.sql
      flyway: /^V(\d+(?:\.\d+)*(?:_\d+)?)__(.+)\.(sql|java)$/i,
      // Liquibase: changelog-1.0.0.xml or 001-initial.xml
      liquibase: /^(?:changelog-)?(\d+(?:\.\d+)*|\d+)-(.+)\.(xml|yaml|sql)$/i,
      // Alembic: 001_initial.py or 20240115_143022_description.py
      alembic: /^(\d+(?:_\d+)?)_(.+)\.py$/i,
      // Prisma: 20240115143022_description/migration.sql
      prisma: /^(\d{14})_(.+)$/i,
      // Rails: 20240115143022_create_users.rb
      rails: /^(\d{14})_(.+)\.rb$/i,
      // Django: 0001_initial.py
      django: /^(\d{4})_(.+)\.py$/i,
      // Knex/TypeORM/Sequelize: 20240115143022_create_users.js
      generic: /^(\d{14}|\d+)[-_](.+)\.(js|ts|sql)$/i,
    };

    const pattern = patterns[tool] || patterns.generic;
    const match = fileName.match(pattern);
    
    if (match) {
      return {
        version: match[1],
        description: match[2]?.replace(/[-_]/g, ' '),
      };
    }
    
    return { version: null, description: null };
  }

  /**
   * Get expected migration paths for a tool
   */
  getMigrationPaths(tool: MigrationTool): string[] {
    return MIGRATION_PATHS[tool] || MIGRATION_PATHS.unknown;
  }

  /**
   * Get all known migration file extensions
   */
  getMigrationFileExtensions(tool: MigrationTool): string[] {
    const extensions: Record<MigrationTool, string[]> = {
      flyway: ['.sql', '.java'],
      liquibase: ['.xml', '.yaml', '.yml', '.sql', '.json'],
      alembic: ['.py'],
      prisma: ['.sql'],
      knex: ['.js', '.ts'],
      typeorm: ['.ts', '.js'],
      sequelize: ['.js', '.ts'],
      rails: ['.rb'],
      django: ['.py'],
      efcore: ['.cs'],
      dbup: ['.sql'],
      goose: ['.sql', '.go'],
      unknown: ['.sql'],
    };
    return extensions[tool] || extensions.unknown;
  }

  /**
   * Calculate overall confidence score for migration detection
   */
  calculateConfidence(
    hasConfigPlugin: boolean,
    hasMigrationFiles: boolean,
    hasWorkflowCommand: boolean,
    fileCount: number
  ): 'high' | 'medium' | 'low' {
    let score = 0;
    
    if (hasConfigPlugin) score += 40;
    if (hasMigrationFiles) score += 30;
    if (hasWorkflowCommand) score += 20;
    if (fileCount > 0) score += Math.min(fileCount * 2, 10);
    
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private matchesConfigFile(actualFile: string, patternFile: string): boolean {
    if (patternFile.startsWith('*')) {
      const ext = patternFile.slice(1);
      return actualFile.endsWith(ext);
    }
    return actualFile === patternFile || actualFile.endsWith('/' + patternFile);
  }

  private extractPluginVersion(content: string, tool: MigrationTool): string | null {
    const versionPatterns: Record<string, RegExp> = {
      flyway: /<version>(\d+\.\d+(?:\.\d+)?)<\/version>/i,
      liquibase: /<version>(\d+\.\d+(?:\.\d+)?)<\/version>/i,
      prisma: /"prisma":\s*"[\^~]?(\d+\.\d+(?:\.\d+)?)"/i,
      knex: /"knex":\s*"[\^~]?(\d+\.\d+(?:\.\d+)?)"/i,
    };

    const pattern = versionPatterns[tool];
    if (pattern) {
      const match = content.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Analyze workflow content for migration safety best practices
   * Now also detects build-integrated and runtime migrations
   */
  analyzeMigrationSafety(
    workflowContent: string, 
    detectedTool?: MigrationTool,
    buildConfigContent?: string,
    detectedBuildSystem?: BuildSystem
  ): {
    hasMigration: boolean;
    migrationMode: 'explicit' | 'build-integrated' | 'runtime' | 'none';
    migrationModeDescription?: string;
    safetyScore: number;
    checks: Array<{
      check: 'validation' | 'backup' | 'dry-run' | 'approval' | 'separate-stage';
      status: 'pass' | 'fail' | 'warning';
      description: string;
      details?: string;
    }>;
    recommendations: string[];
  } {
    const checks: Array<{
      check: 'validation' | 'backup' | 'dry-run' | 'approval' | 'separate-stage';
      status: 'pass' | 'fail' | 'warning';
      description: string;
      details?: string;
    }> = [];
    const recommendations: string[] = [];

    // Check for explicit migration commands in workflow
    const hasExplicitMigration = WORKFLOW_COMMAND_PATTERNS.some(p => p.pattern.test(workflowContent));
    
    // Check for build-integrated migrations (Maven/Gradle lifecycle commands when tool is detected)
    let hasBuildIntegrated = false;
    let buildIntegratedDescription = '';
    
    if (detectedTool && detectedBuildSystem) {
      const buildPattern = BUILD_INTEGRATED_PATTERNS.find(p => 
        p.tool === detectedTool && 
        p.buildSystem === detectedBuildSystem && 
        p.workflowPattern.test(workflowContent)
      );
      if (buildPattern) {
        hasBuildIntegrated = true;
        buildIntegratedDescription = buildPattern.description;
      }
    }
    
    // Check for runtime migrations (Spring Boot auto-config, etc.)
    let hasRuntimeMigration = false;
    let runtimeDescription = '';
    
    if (buildConfigContent && detectedTool) {
      const runtimePattern = RUNTIME_MIGRATION_PATTERNS.find(p => 
        p.tool === detectedTool && p.pattern.test(buildConfigContent)
      );
      if (runtimePattern) {
        hasRuntimeMigration = true;
        runtimeDescription = runtimePattern.description;
      }
    }
    
    // Determine migration mode
    let migrationMode: 'explicit' | 'build-integrated' | 'runtime' | 'none' = 'none';
    let migrationModeDescription = '';
    
    if (hasExplicitMigration) {
      migrationMode = 'explicit';
      migrationModeDescription = 'Explicit migration commands in workflow';
    } else if (hasRuntimeMigration && hasBuildIntegrated) {
      migrationMode = 'runtime';
      migrationModeDescription = runtimeDescription;
    } else if (hasBuildIntegrated) {
      migrationMode = 'build-integrated';
      migrationModeDescription = buildIntegratedDescription;
    }
    
    const hasMigration = migrationMode !== 'none';
    
    if (!hasMigration) {
      return {
        hasMigration: false,
        migrationMode: 'none',
        safetyScore: 100,
        checks: [],
        recommendations: [],
      };
    }

    // 1. Check for pre-migration validation
    const hasValidation = VALIDATION_PATTERNS.some(p => 
      p.pattern.test(workflowContent) && (!p.tool || p.tool === detectedTool)
    );
    const validationMatch = VALIDATION_PATTERNS.find(p => 
      p.pattern.test(workflowContent) && (!p.tool || p.tool === detectedTool)
    );
    
    // For runtime migrations, validation is less critical (Spring Boot validates on startup)
    const validationStatus = hasValidation ? 'pass' : (migrationMode === 'runtime' ? 'warning' : 'fail');
    
    checks.push({
      check: 'validation',
      status: validationStatus,
      description: 'Pre-migration validation',
      details: hasValidation 
        ? validationMatch?.description 
        : migrationMode === 'runtime'
          ? 'Runtime migration - Spring Boot validates on startup'
          : 'No validation step detected before migration',
    });
    
    if (!hasValidation && migrationMode !== 'runtime') {
      const toolValidation = this.getValidationCommand(detectedTool);
      if (toolValidation) {
        recommendations.push(`Add validation step: \`${toolValidation}\``);
      }
    }

    // 2. Check for database backup
    const hasBackup = BACKUP_PATTERNS.some(p => p.pattern.test(workflowContent));
    const backupMatch = BACKUP_PATTERNS.find(p => p.pattern.test(workflowContent));
    
    checks.push({
      check: 'backup',
      status: hasBackup ? 'pass' : 'fail',
      description: 'Database backup before migration',
      details: hasBackup 
        ? backupMatch?.description 
        : 'No backup step detected before migration',
    });
    
    if (!hasBackup) {
      recommendations.push('Add database backup step (pg_dump, mysqldump, or cloud snapshot) before migration');
    }

    // 3. Check for dry-run/preview
    const hasDryRun = DRY_RUN_PATTERNS.some(p => 
      p.pattern.test(workflowContent) && (!p.tool || p.tool === detectedTool)
    );
    const dryRunMatch = DRY_RUN_PATTERNS.find(p => 
      p.pattern.test(workflowContent) && (!p.tool || p.tool === detectedTool)
    );
    
    checks.push({
      check: 'dry-run',
      status: hasDryRun ? 'pass' : 'warning',
      description: 'Dry-run or preview step',
      details: hasDryRun 
        ? dryRunMatch?.description 
        : 'No dry-run/preview step detected',
    });
    
    if (!hasDryRun) {
      const dryRunCmd = this.getDryRunCommand(detectedTool);
      if (dryRunCmd) {
        recommendations.push(`Consider adding preview step: \`${dryRunCmd}\``);
      }
    }

    // 4. Check for approval gate
    const hasApproval = APPROVAL_PATTERNS.some(p => p.pattern.test(workflowContent));
    const approvalMatch = APPROVAL_PATTERNS.find(p => p.pattern.test(workflowContent));
    const hasEnvironment = /environment:\s*production/i.test(workflowContent);
    
    checks.push({
      check: 'approval',
      status: hasApproval || hasEnvironment ? 'pass' : 'fail',
      description: 'Approval gate for production',
      details: hasApproval 
        ? approvalMatch?.description 
        : hasEnvironment 
          ? 'GitHub environment protection available'
          : 'No approval gate or environment protection detected',
    });
    
    if (!hasApproval && !hasEnvironment) {
      recommendations.push('Add GitHub environment with required reviewers for production migrations');
    }

    // 5. Check for separate migration stage
    const separateStage = this.detectSeparateMigrationStage(workflowContent);
    
    checks.push({
      check: 'separate-stage',
      status: separateStage.isSeparate ? 'pass' : 'warning',
      description: 'Migration in separate job/stage',
      details: separateStage.isSeparate 
        ? `Migration runs in dedicated job: ${separateStage.jobName || 'migration job'}`
        : 'Migration appears to be mixed with deployment steps',
    });
    
    if (!separateStage.isSeparate) {
      recommendations.push('Consider separating database migration into its own job for better failure isolation');
    }

    // Calculate safety score
    const passCount = checks.filter(c => c.status === 'pass').length;
    const warningCount = checks.filter(c => c.status === 'warning').length;
    const safetyScore = Math.round(((passCount + warningCount * 0.5) / checks.length) * 100);

    return {
      hasMigration,
      migrationMode,
      migrationModeDescription,
      safetyScore,
      checks,
      recommendations,
    };
  }

  private getValidationCommand(tool?: MigrationTool): string | null {
    const commands: Record<MigrationTool, string> = {
      flyway: 'flyway validate',
      liquibase: 'liquibase validate',
      efcore: 'dotnet ef migrations list',
      prisma: 'prisma validate',
      alembic: 'alembic check',
      rails: 'rails db:migrate:status',
      django: 'python manage.py showmigrations',
      knex: 'knex migrate:status',
      typeorm: 'typeorm migration:show',
      sequelize: 'npx sequelize-cli db:migrate:status',
      goose: 'goose status',
      dbup: '',
      unknown: '',
    };
    return tool ? commands[tool] || null : null;
  }

  private getDryRunCommand(tool?: MigrationTool): string | null {
    const commands: Record<MigrationTool, string> = {
      flyway: 'flyway info',
      liquibase: 'liquibase updateSQL',
      efcore: 'dotnet ef migrations script',
      prisma: 'prisma migrate diff',
      alembic: 'alembic upgrade --sql',
      rails: 'rails db:migrate:status',
      django: 'python manage.py sqlmigrate',
      knex: 'knex migrate:list',
      typeorm: 'typeorm migration:show',
      sequelize: 'npx sequelize-cli db:migrate:status',
      goose: 'goose status',
      dbup: '',
      unknown: '',
    };
    return tool ? commands[tool] || null : null;
  }

  private detectSeparateMigrationStage(workflowContent: string): { isSeparate: boolean; jobName: string | null } {
    // Look for job names that suggest dedicated migration
    const migrationJobPatterns = [
      /^\s{2}(migrate|migration|db-migrate|database-migration|schema-update):/im,
      /^\s{2}(\w+-?migration\w*):/im,
      /^\s{2}(\w+-?migrate):/im,
    ];
    
    for (const pattern of migrationJobPatterns) {
      const match = workflowContent.match(pattern);
      if (match) {
        return { isSeparate: true, jobName: match[1] };
      }
    }
    
    // Check if migration commands appear in a job that also has deploy commands
    const hasDeployInSameJob = /deploy|push|publish/i.test(workflowContent) && 
      WORKFLOW_COMMAND_PATTERNS.some(p => p.pattern.test(workflowContent));
    
    // If there are multiple jobs and migration is separate from deploy
    const jobCount = (workflowContent.match(/^\s{2}\w[\w-]*:$/gm) || []).length;
    
    if (jobCount > 1 && !hasDeployInSameJob) {
      return { isSeparate: true, jobName: null };
    }
    
    return { isSeparate: false, jobName: null };
  }

  private extractWorkflowContext(
    content: string,
    matchIndex: number
  ): { jobName: string; stepName: string | null; environment: string | null } {
    // Find the job name by looking backwards for "jobs:" and job key
    const beforeMatch = content.slice(0, matchIndex);
    
    // Look for job name
    const jobMatch = beforeMatch.match(/^\s{2}(\w[\w-]*):$/gm);
    const jobName = jobMatch ? jobMatch[jobMatch.length - 1]?.trim().replace(':', '') : 'unknown';
    
    // Look for step name
    const stepMatch = beforeMatch.match(/^\s+-\s+name:\s+(.+)$/gm);
    const stepName = stepMatch ? stepMatch[stepMatch.length - 1]?.replace(/^\s+-\s+name:\s+/, '').trim() : null;
    
    // Look for environment
    const envMatch = beforeMatch.match(/environment:\s*(\w+)/i);
    const environment = envMatch ? envMatch[1] : null;
    
    return { jobName, stepName, environment };
  }

  private detectApprovalGate(workflowContent: string): boolean {
    // Check for environment with protection rules
    if (/environment:\s*\w+/.test(workflowContent)) {
      return true;
    }
    // Check for manual approval steps
    if (/workflow_dispatch|manual/i.test(workflowContent)) {
      return true;
    }
    // Check for approval comments
    if (/approval|review|gate/i.test(workflowContent)) {
      return true;
    }
    return false;
  }

  private getLineNumber(content: string, index: number): number {
    return content.slice(0, index).split('\n').length;
  }

  private extractStatement(content: string, startIndex: number): string {
    // Find the end of the statement (semicolon or end of line)
    const endIndex = content.indexOf(';', startIndex);
    if (endIndex === -1) {
      const lineEnd = content.indexOf('\n', startIndex);
      return content.slice(startIndex, lineEnd === -1 ? undefined : lineEnd).trim();
    }
    return content.slice(startIndex, endIndex + 1).trim();
  }
}

// Export singleton instance
export const migrationDetector = new MigrationDetector();
