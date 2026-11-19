export interface HelpFlagSchema {
  name: string;
  alias?: string;
  arg?: string;
  description: string;
}

export interface HelpCommandSchema {
  name: string;
  usage: string;
  description: string;
  flags?: HelpFlagSchema[];
  subcommands?: HelpCommandSchema[];
  destructive?: boolean;
}

export interface HelpExitCodeSchema {
  code: number;
  name: string;
  description: string;
}

export interface CliHelpSchema {
  name: string;
  schemaVersion: number;
  description: string;
  globalFlags: HelpFlagSchema[];
  exitCodes: HelpExitCodeSchema[];
  commands: HelpCommandSchema[];
}

export const CLI_HELP_SCHEMA: CliHelpSchema = {
  name: 'tsubasa',
  schemaVersion: 1,
  description: 'Tsubasa headless CLI for pooled Google Drive virtual filesystem operations.',
  globalFlags: [
    { name: '--json', description: 'Emit deterministic JSON output on stdout.' },
    { name: '--dry-run', description: 'Preview mutations and placement plans without writing changes.' },
    { name: '--yes', alias: '-y', description: 'Confirm destructive actions without interactive prompts.' },
    { name: '--quiet', alias: '-q', description: 'Suppress non-essential progress and human status output.' },
    { name: '--show-emails', description: 'Display unmasked Google account email addresses in output.' },
    { name: '--pool', arg: '<id|slug>', description: 'Scope operation to a specific storage pool.' },
    { name: '--server', arg: '<url>', description: 'Target a running Tsubasa HTTP server.' },
    { name: '--local', description: 'Force direct local SQLite and Drive execution without an HTTP server.' },
    { name: '--home', arg: '<dir>', description: 'Override the Tsubasa state and database directory.' },
    { name: '--help', alias: '-h', description: 'Show command usage and flag documentation.' },
  ],
  exitCodes: [
    { code: 0, name: 'success', description: 'Command completed without errors.' },
    { code: 1, name: 'runtime_error', description: 'Unexpected internal or runtime execution failure.' },
    { code: 2, name: 'usage_or_validation_error', description: 'Invalid CLI arguments, flags, or input parameters.' },
    { code: 3, name: 'quota_or_ceiling_exceeded', description: 'Account storage headroom or 24-hour transfer ceiling exceeded.' },
    { code: 4, name: 'conflict_or_lock_held', description: 'Target path conflict or database/job lock is currently held.' },
    { code: 5, name: 'auth_or_upstream_error', description: 'OAuth token failure or Google Drive upstream error.' },
    { code: 6, name: 'not_found', description: 'Requested virtual path, pool, account, or job was not found.' },
  ],
  commands: [
    {
      name: 'status',
      usage: 'tsubasa status',
      description: 'Show storage pool capacity, active accounts, and sync health.',
    },
    {
      name: 'ls',
      usage: 'tsubasa ls [path]',
      description: 'List virtual directory entries from the local SQLite index.',
    },
    {
      name: 'stat',
      usage: 'tsubasa stat <path>',
      description: 'Inspect detailed virtual metadata and physical shard placement for a path.',
    },
    {
      name: 'find',
      usage: 'tsubasa find [query]',
      description: 'Search indexed files and folders by name, path, MIME type, or account.',
    },
    {
      name: 'mkdir',
      usage: 'tsubasa mkdir <path>',
      description: 'Create a virtual directory in the local index.',
    },
    {
      name: 'mv',
      usage: 'tsubasa mv <src> <dst>',
      description: 'Move or rename a virtual file or folder immediately in the index.',
    },
    {
      name: 'cp',
      usage: 'tsubasa cp <src> <dst>',
      description: 'Duplicate a virtual file entry or copy across virtual paths.',
    },
    {
      name: 'rm',
      usage: 'tsubasa rm <path>',
      description: 'Move a virtual file or directory tree to trash or delete permanently.',
      destructive: true,
    },
    {
      name: 'upload',
      usage: 'tsubasa upload <local-path> <remote-path>',
      description: 'Stream a local file or directory to pooled Google Drive storage.',
    },
    {
      name: 'download',
      usage: 'tsubasa download <remote-path> [local-path]',
      description: 'Stream a virtual file or directory from Google Drive to local disk.',
    },
    {
      name: 'export',
      usage: 'tsubasa export <remote-path> <local-path>',
      description: 'Export a Google Workspace document to a converted file format.',
    },
    {
      name: 'audit',
      usage: 'tsubasa audit',
      description: 'Verify local index integrity against account quotas and shard invariants.',
    },
    {
      name: 'dupes',
      usage: 'tsubasa dupes [path]',
      description: 'Find duplicate files by content checksum or identical size and name.',
    },
    {
      name: 'pool',
      usage: 'tsubasa pool <action>',
      description: 'Manage storage pools and account placement ordering.',
      subcommands: [
        { name: 'list', usage: 'tsubasa pool list', description: 'List all configured storage pools.' },
        { name: 'show', usage: 'tsubasa pool show <pool>', description: 'Show accounts and quota utilization for a pool.' },
        { name: 'create', usage: 'tsubasa pool create <name>', description: 'Create a new storage pool.' },
        { name: 'rename', usage: 'tsubasa pool rename <pool> <new-name>', description: 'Rename an existing storage pool.' },
        { name: 'delete', usage: 'tsubasa pool delete <pool>', description: 'Delete an empty storage pool.', destructive: true },
        { name: 'reorder', usage: 'tsubasa pool reorder <pool> <account-ids...>', description: 'Set priority order of accounts in a pool.' },
        { name: 'rebalance', usage: 'tsubasa pool rebalance [pool]', description: 'Plan or execute shard migrations to balance pool fill levels.' },
      ],
    },
    {
      name: 'account',
      usage: 'tsubasa account <action>',
      description: 'Manage connected Google Drive accounts and headroom status.',
      subcommands: [
        { name: 'list', usage: 'tsubasa account list', description: 'List connected Google Drive accounts.' },
        { name: 'show', usage: 'tsubasa account show <id>', description: 'Show quota, rolling transfer window, and sync token state for an account.' },
        { name: 'quota', usage: 'tsubasa account quota [id]', description: 'Refresh and display strict 750 MB ceiling headroom across accounts.' },
        { name: 'enable', usage: 'tsubasa account enable <id>', description: 'Enable an account for new file placements.' },
        { name: 'disable', usage: 'tsubasa account disable <id>', description: 'Disable new placements on an account while keeping reads active.' },
        { name: 'evacuate', usage: 'tsubasa account evacuate <id>', description: 'Migrate all stored files off an account onto remaining pool members.', destructive: true },
        { name: 'move-pool', usage: 'tsubasa account move-pool <id> <pool>', description: 'Reassign an account to another storage pool.' },
        { name: 'remove', usage: 'tsubasa account remove <id>', description: 'Unlink an account from Tsubasa.', destructive: true },
      ],
    },
    {
      name: 'job',
      usage: 'tsubasa job <action>',
      description: 'Inspect and control resumable transfer and migration jobs.',
      subcommands: [
        { name: 'list', usage: 'tsubasa job list', description: 'List active, paused, and recent background jobs.' },
        { name: 'status', usage: 'tsubasa job status <job-id>', description: 'Show chunk progress and error details for a job.' },
        { name: 'resume', usage: 'tsubasa job resume <job-id>', description: 'Resume an interrupted upload, download, or evacuation job.' },
        { name: 'cancel', usage: 'tsubasa job cancel <job-id>', description: 'Cancel an in-progress or paused job.', destructive: true },
      ],
    },
    {
      name: 'trash',
      usage: 'tsubasa trash <action>',
      description: 'Inspect, restore, or permanently purge trashed virtual items.',
      subcommands: [
        { name: 'list', usage: 'tsubasa trash list', description: 'List items currently in the virtual trash.' },
        { name: 'restore', usage: 'tsubasa trash restore <id|path>', description: 'Restore a trashed item back to its original virtual path.' },
        { name: 'purge', usage: 'tsubasa trash purge [id|path]', description: 'Permanently delete trashed items from Google Drive and SQLite.', destructive: true },
      ],
    },
    {
      name: 'share',
      usage: 'tsubasa share <action>',
      description: 'Audit and revoke external Google Drive sharing permissions.',
      subcommands: [
        { name: 'list', usage: 'tsubasa share list', description: 'List files with active external sharing links or permissions.' },
        { name: 'clear', usage: 'tsubasa share clear <path|id>', description: 'Revoke external sharing links on a virtual file.', destructive: true },
      ],
    },
    {
      name: 'outbox',
      usage: 'tsubasa outbox <action>',
      description: 'Manage queued asynchronous Drive metadata and appProperties mutations.',
      subcommands: [
        { name: 'list', usage: 'tsubasa outbox list', description: 'List pending and failed lazy-sync metadata operations.' },
        { name: 'retry', usage: 'tsubasa outbox retry [id]', description: 'Replay failed or pending outbox mutations against Google Drive.' },
        { name: 'drop', usage: 'tsubasa outbox drop <id>', description: 'Discard a stuck outbox entry from the queue.', destructive: true },
      ],
    },
    {
      name: 'sync',
      usage: 'tsubasa sync <action>',
      description: 'Synchronize local SQLite state with remote Google Drive changes.',
      subcommands: [
        { name: 'delta', usage: 'tsubasa sync delta [account-id]', description: 'Fetch incremental changes using stored Drive changes.list tokens.' },
        { name: 'cold', usage: 'tsubasa sync cold [account-id]', description: 'Run a full initial metadata crawl to populate the local index.' },
      ],
    },
    {
      name: 'auth',
      usage: 'tsubasa auth <action>',
      description: 'Authenticate and verify Google OAuth credentials.',
      subcommands: [
        { name: 'check', usage: 'tsubasa auth check [account-id]', description: 'Verify OAuth token validity and required Drive API scopes.' },
        { name: 'add', usage: 'tsubasa auth add', description: 'Connect a new Google Drive account via OAuth.' },
      ],
    },
    {
      name: 'db',
      usage: 'tsubasa db <action>',
      description: 'Perform local SQLite database maintenance.',
      subcommands: [
        { name: 'backup', usage: 'tsubasa db backup [dest-path]', description: 'Create a consistent snapshot backup of the local SQLite index.' },
      ],
    },
    {
      name: 'ext',
      usage: 'tsubasa ext <action>',
      description: 'Discover and execute external Tsubasa CLI extensions.',
      subcommands: [
        { name: 'list', usage: 'tsubasa ext list', description: 'List installed tsubasa-* extension executables on PATH.' },
        { name: '<name>', usage: 'tsubasa ext <name> [args...]', description: 'Invoke an external tsubasa-<name> extension binary.' },
      ],
    },
    {
      name: 'import',
      usage: 'tsubasa import <action>',
      description: 'Adopt existing remote cloud files into the virtual filesystem index.',
      subcommands: [
        { name: 'drive', usage: 'tsubasa import drive <folder-id-or-url>', description: 'Import an external Google Drive folder tree into a storage pool.' },
        { name: 'tokens', usage: 'tsubasa import tokens <list|clear>', description: 'List or clear cached external source OAuth tokens.' },
      ],
    },
    {
      name: 'plan',
      usage: 'tsubasa plan <action>',
      description: 'Simulate storage placement and quota impact without transferring bytes.',
      subcommands: [
        { name: 'upload', usage: 'tsubasa plan upload <local-path> <remote-path>', description: 'Compute Folder-Cohesion Best-Fit account assignments for an upload.' },
        { name: 'import-drive', usage: 'tsubasa plan import-drive <account-id> [remote-folder-id]', description: 'Preview virtual path mappings for a Drive import operation.' },
      ],
    },
  ],
};

export function serializeHelpSchema(pretty = false): string {
  return JSON.stringify(CLI_HELP_SCHEMA, null, pretty ? 2 : undefined);
}
