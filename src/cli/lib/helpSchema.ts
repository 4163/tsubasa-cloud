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
    { name: '--json', description: 'Emit deterministic JSON output on stdout and JSON error envelopes on stderr.' },
    { name: '--dry-run', description: 'Preview mutations and placement plans without writing changes.' },
    { name: '--yes', alias: '-y', description: 'Confirm destructive actions without interactive prompts.' },
    { name: '--quiet', alias: '-q', description: 'Suppress non-essential progress and human status output.' },
    { name: '--show-emails', description: 'Display unmasked Google account email addresses in output.' },
    { name: '--no-wait-outbox', description: 'Skip draining queued Drive outbox operations before exiting standalone mode.' },
    { name: '--pool', arg: '<id|slug>', description: 'Scope operation to a specific storage pool.' },
    { name: '--server', arg: '<url>', description: 'Target a running Tsubasa HTTP server without local fallback.' },
    { name: '--local', description: 'Force direct local SQLite and Drive execution without probing HTTP.' },
    { name: '--home', arg: '<dir>', description: 'Override the Tsubasa home directory containing data/ and .oauths/.' },
    { name: '--help', alias: '-h', description: 'Show command usage and flag documentation.' },
  ],
  exitCodes: [
    { code: 0, name: 'success', description: 'Command completed without errors.' },
    { code: 1, name: 'runtime_error', description: 'Unexpected internal or runtime execution failure.' },
    { code: 2, name: 'usage_or_validation_error', description: 'Invalid arguments, ambiguous selector, or missing --yes in non-TTY mode.' },
    { code: 3, name: 'quota_or_ceiling_exceeded', description: '750 MB reserve headroom, 14.25 GB file ceiling, or 750 GB 24-hour upload cap exceeded.' },
    { code: 4, name: 'conflict_or_lock_held', description: 'Path conflict, writer lock held, pool not empty, or Share Pool read-only.' },
    { code: 5, name: 'auth_or_upstream_error', description: 'OAuth failure, Google Drive upstream error, or unreachable explicit server.' },
    { code: 6, name: 'not_found', description: 'Requested path, pool, account, job, or extension was not found.' },
  ],
  commands: [
    {
      name: 'status',
      usage: 'tsubasa status',
      description: 'Show storage pools, account counts, headroom totals, outbox health, and active transport.',
    },
    {
      name: 'ls',
      usage: 'tsubasa ls [path]',
      description: 'List virtual directory entries from the local SQLite index.',
      flags: [
        { name: '--recursive', alias: '-r', description: 'List nested directories and files recursively.' },
        { name: '--limit', arg: '<n>', description: 'Maximum number of entries to return.' },
        { name: '--cursor', arg: '<afterPath>', description: 'Resume listing strictly after the given virtual path.' },
        { name: '--format', arg: '<table|json|jsonl>', description: 'Output format (default table, or json with --json).' },
      ],
    },
    {
      name: 'stat',
      usage: 'tsubasa stat <path>',
      description: 'Inspect indexed metadata for a virtual file or folder.',
    },
    {
      name: 'find',
      usage: 'tsubasa find [query]',
      description: 'Search indexed files and folders by substring or glob pattern.',
      flags: [
        { name: '--glob', arg: '<pattern>', description: 'Match item names or paths against a glob pattern.' },
        { name: '--path', arg: '<dir>', description: 'Restrict search to a virtual directory subtree.' },
        { name: '--limit', arg: '<n>', description: 'Maximum number of entries to return.' },
        { name: '--cursor', arg: '<afterPath>', description: 'Resume search strictly after the given virtual path.' },
        { name: '--format', arg: '<table|json|jsonl>', description: 'Output format.' },
      ],
    },
    {
      name: 'mkdir',
      usage: 'tsubasa mkdir <path>',
      description: 'Create a virtual directory in the local index.',
    },
    {
      name: 'mv',
      usage: 'tsubasa mv <src...> <dst>',
      description: 'Move or rename virtual files and folders within a pool or across pools.',
      flags: [
        { name: '--to-pool', arg: '<id|slug>', description: 'Target pool for cross-pool moves.' },
        { name: '--conflict', arg: '<reject|skip|keep_both|overwrite>', description: 'Collision policy when moving items.' },
        { name: '--stdin', description: 'Read newline-delimited source paths from standard input.' },
        { name: '--wait', description: 'Wait for a cross-pool move job to complete.' },
        { name: '--detach', description: 'Return cross-pool job ID immediately (HTTP server mode only).' },
      ],
    },
    {
      name: 'cp',
      usage: 'tsubasa cp <src...> <dst>',
      description: 'Copy virtual files or folders within a storage pool.',
      flags: [
        { name: '--stdin', description: 'Read newline-delimited source paths from standard input.' },
      ],
    },
    {
      name: 'rm',
      usage: 'tsubasa rm <paths...>',
      description: 'Move virtual files or folders to trash, or delete permanently.',
      destructive: true,
      flags: [
        { name: '--permanent', description: 'Permanently delete from Drive and SQLite (requires --yes in non-TTY mode).' },
        { name: '--stdin', description: 'Read newline-delimited virtual paths from standard input.' },
      ],
    },
    {
      name: 'upload',
      usage: 'tsubasa upload <local-path|-> <remote-path>',
      description: 'Upload local files or directories with MD5 verification and resumable chunks over 5 MiB.',
      flags: [
        { name: '--recursive', alias: '-r', description: 'Upload a local directory tree recursively.' },
        { name: '--conflict', arg: '<reject|replace|keep_both|skip>', description: 'Collision policy for existing target paths.' },
        { name: '--chunk-size', arg: '<bytes>', description: '256 KiB-aligned chunk size for resumable uploads (default 8 MiB).' },
        { name: '--concurrency', arg: '<n>', description: 'Concurrent uploads keeping chunkSize * concurrency <= 32 MiB.' },
        { name: '--size', arg: '<bytes>', description: 'Required exact byte length when reading a single file from stdin (-).' },
      ],
    },
    {
      name: 'download',
      usage: 'tsubasa download <remote-path> [local-path|-]',
      description: 'Download files or folders with client-side .part resume and hash verification.',
      flags: [
        { name: '--stdin', description: 'Read newline-delimited remote paths from standard input.' },
      ],
    },
    {
      name: 'export',
      usage: 'tsubasa export [flags]',
      description: 'Export canonical Tsubasa catalog entities as JSON, streaming JSONL, or single-entity CSV.',
      flags: [
        { name: '--preset', arg: '<minimal|standard|full>', description: 'Entity set and field detail preset (default standard).' },
        { name: '--include', arg: '<entities>', description: 'Comma-separated entities to export.' },
        { name: '--entity', arg: '<name>', description: 'Single entity required when using --format csv or --fields.' },
        { name: '--fields', arg: '<cols>', description: 'Comma-separated columns to project (requires single --entity).' },
        { name: '--format', arg: '<json|jsonl|csv>', description: 'Output format (default json; csv requires --entity).' },
        { name: '--account', arg: '<selector>', description: 'Filter export to a single account.' },
        { name: '--path', arg: '<prefix>', description: 'Filter folders and files to a virtual path prefix.' },
        { name: '--trashed', arg: '<exclude|include|only>', description: 'Trashed file filter (default exclude).' },
      ],
    },
    {
      name: 'audit',
      usage: 'tsubasa audit [--local|--remote]',
      description: 'Verify local SQLite integrity, quota drift, and outbox health, or run remote Drive discrepancy scan.',
      flags: [
        { name: '--local', description: 'Run read-only local SQLite integrity and quota audit (default).' },
        { name: '--remote', description: 'Run remote Google Drive discrepancy scan.' },
      ],
    },
    {
      name: 'dupes',
      usage: 'tsubasa dupes [--by hash|name-size]',
      description: 'Find duplicate files by indexed content hash or identical name and byte size.',
      flags: [
        { name: '--by', arg: '<hash|name-size>', description: 'Deduplication key (default hash).' },
      ],
    },
    {
      name: 'pool',
      usage: 'tsubasa pool <action>',
      description: 'Manage storage pools, slugs, display order, and over-ceiling rebalancing.',
      subcommands: [
        { name: 'list', usage: 'tsubasa pool list', description: 'List storage pools ordered by sort_order.' },
        { name: 'show', usage: 'tsubasa pool show <id|slug>', description: 'Show pool details, headroom, and member accounts.' },
        {
          name: 'create',
          usage: 'tsubasa pool create <name> [--slug <slug>]',
          description: 'Create a new storage pool.',
          flags: [{ name: '--slug', arg: '<slug>', description: 'Explicit non-numeric slug for the pool.' }],
        },
        {
          name: 'rename',
          usage: 'tsubasa pool rename <id|slug> <new-name> [--slug <new-slug>]',
          description: 'Rename a pool while preserving its slug unless --slug is passed.',
          flags: [{ name: '--slug', arg: '<new-slug>', description: 'Explicitly update the pool slug.' }],
        },
        { name: 'delete', usage: 'tsubasa pool delete <id|slug>', description: 'Delete an empty storage pool.', destructive: true },
        { name: 'reorder', usage: 'tsubasa pool reorder <slugs...>', description: 'Set the sort_order of all standard storage pools.' },
        {
          name: 'rebalance',
          usage: 'tsubasa pool rebalance [pool] [--account <selector>]',
          description: 'Move files off over-ceiling accounts exceeding the 750 MB safety reserve.',
          flags: [{ name: '--account', arg: '<selector>', description: 'Restrict rebalance to one over-ceiling account.' }],
        },
      ],
    },
    {
      name: 'account',
      usage: 'tsubasa account <action>',
      description: 'Manage connected Google Drive accounts, quota headroom, evacuation, and pool assignment.',
      subcommands: [
        { name: 'list', usage: 'tsubasa account list', description: 'List connected Google Drive accounts.' },
        { name: 'show', usage: 'tsubasa account show <account>', description: 'Show quota, 24-hour transfer stats, and sync state for an account.' },
        {
          name: 'quota',
          usage: 'tsubasa account quota <account> [--refresh]',
          description: 'Display strict 750 MB reserve headroom, optionally refreshing live from Drive.',
          flags: [{ name: '--refresh', description: 'Fetch live storageQuota from Google Drive before displaying.' }],
        },
        { name: 'enable', usage: 'tsubasa account enable <account>', description: 'Enable an account for new file placements.' },
        { name: 'disable', usage: 'tsubasa account disable <account>', description: 'Disable new placements on an account while keeping reads active.' },
        {
          name: 'evacuate',
          usage: 'tsubasa account evacuate <account> [--wait]',
          description: 'Evacuate all stored files off an account onto remaining pool members via a persisted job.',
          destructive: true,
          flags: [
            { name: '--wait', description: 'Wait for evacuation job completion.' },
            { name: '--detach', description: 'Queue evacuation and return jobId immediately (HTTP mode only).' },
          ],
        },
        {
          name: 'move-pool',
          usage: 'tsubasa account move-pool <account> --to <pool> [--evacuate]',
          description: 'Move an empty account (or evacuate first with --evacuate) to another pool.',
          flags: [
            { name: '--to', arg: '<id|slug>', description: 'Destination storage pool.' },
            { name: '--evacuate', description: 'Evacuate files before switching pools.' },
          ],
        },
        {
          name: 'remove',
          usage: 'tsubasa account remove <account> [--evacuate] [--wait]',
          description: 'Unlink an account (requires --evacuate --yes when the account still holds files).',
          destructive: true,
          flags: [
            { name: '--evacuate', description: 'Evacuate stored files before removing the account.' },
            { name: '--wait', description: 'Wait for evacuation and removal to finish.' },
          ],
        },
      ],
    },
    {
      name: 'job',
      usage: 'tsubasa job <action>',
      description: 'Inspect, resume, and cancel persisted transfer and evacuation jobs.',
      subcommands: [
        {
          name: 'list',
          usage: 'tsubasa job list [--kind <kind>] [--status <status>] [--limit <n>]',
          description: 'List persisted transfer jobs and live in-memory OAuth cold sync jobs.',
        },
        {
          name: 'status',
          usage: 'tsubasa job status <job-id> [--follow]',
          description: 'Show item progress, byte totals, and error details for a job.',
          flags: [{ name: '--follow', description: 'Poll until the job reaches a terminal state.' }],
        },
        {
          name: 'resume',
          usage: 'tsubasa job resume <job-id> [--detach]',
          description: 'Resume an interrupted upload, cross-pool move, evacuation, or Drive import job.',
          flags: [{ name: '--detach', description: 'Resume asynchronously in HTTP server mode.' }],
        },
        { name: 'cancel', usage: 'tsubasa job cancel <job-id>', description: 'Cancel an active or paused job and revoke temporary Drive shares.', destructive: true },
      ],
    },
    {
      name: 'trash',
      usage: 'tsubasa trash <action>',
      description: 'Inspect, restore, or permanently purge trashed virtual items.',
      subcommands: [
        { name: 'list', usage: 'tsubasa trash list', description: 'List items currently in the virtual trash.' },
        { name: 'restore', usage: 'tsubasa trash restore <ids...>', description: 'Restore trashed items back to their virtual paths.' },
        { name: 'purge', usage: 'tsubasa trash purge', description: 'Permanently delete all trashed items in the active pool.', destructive: true },
      ],
    },
    {
      name: 'share',
      usage: 'tsubasa share <action>',
      description: 'List Share Pool links or clear the Share Pool.',
      subcommands: [
        { name: 'list', usage: 'tsubasa share list', description: 'List active Share Pool links.' },
        { name: 'clear', usage: 'tsubasa share clear', description: 'Clear all items and links from the Share Pool.', destructive: true },
      ],
    },
    {
      name: 'outbox',
      usage: 'tsubasa outbox <action>',
      description: 'Inspect, retry, or drop queued asynchronous Drive metadata mutations.',
      subcommands: [
        {
          name: 'list',
          usage: 'tsubasa outbox list [--status <pending|processing|failed|dead>]',
          description: 'List queued Drive outbox entries.',
        },
        {
          name: 'retry',
          usage: 'tsubasa outbox retry [--account <selector>]',
          description: 'Schedule failed outbox entries for immediate retry.',
          flags: [{ name: '--account', arg: '<selector>', description: 'Restrict retry to one account.' }],
        },
        {
          name: 'drop',
          usage: 'tsubasa outbox drop [id] [--force]',
          description: 'Drop dead and failed outbox rows (or pending rows with --force).',
          destructive: true,
          flags: [{ name: '--force', description: 'Allow dropping pending outbox rows (run sync cold afterwards).' }],
        },
      ],
    },
    {
      name: 'sync',
      usage: 'tsubasa sync <action>',
      description: 'Synchronize local SQLite state with remote Google Drive changes.',
      subcommands: [
        { name: 'delta', usage: 'tsubasa sync delta [account]', description: 'Fetch incremental changes using stored Drive changes.list tokens.' },
        { name: 'cold', usage: 'tsubasa sync cold [account]', description: 'Run a full metadata crawl to reconcile the local SQLite index.' },
      ],
    },
    {
      name: 'auth',
      usage: 'tsubasa auth <action>',
      description: 'Verify or add Google Drive OAuth credentials.',
      subcommands: [
        { name: 'check', usage: 'tsubasa auth check [account]', description: 'Verify local OAuth credentials and authorization status read-only.' },
        {
          name: 'add',
          usage: 'tsubasa auth add <cred.json> [--no-browser]',
          description: 'Import OAuth credentials and authorize via ephemeral loopback OAuth.',
          flags: [{ name: '--no-browser', description: 'Print the authorization URL without opening a browser.' }],
        },
      ],
    },
    {
      name: 'db',
      usage: 'tsubasa db <action>',
      description: 'Perform local SQLite database maintenance.',
      subcommands: [
        { name: 'backup', usage: 'tsubasa db backup <dest-path>', description: 'Create an online WAL-safe SQLite backup via sqlite.backup().' },
      ],
    },
    {
      name: 'ext',
      usage: 'tsubasa ext <list|<name>> [args...]',
      description: 'Discover and execute manifest-declared extensions under extensions/<name>/.',
      subcommands: [
        { name: 'list', usage: 'tsubasa ext list', description: 'List extensions discovered from extensions/<name>/manifest.json.' },
        { name: '<name>', usage: 'tsubasa ext <name> [args...]', description: 'Execute an extension with verbatim trailing arguments.' },
      ],
    },
    {
      name: 'import',
      usage: 'tsubasa import <action>',
      description: 'Import external Google Drive folders into a storage pool and manage source tokens.',
      subcommands: [
        {
          name: 'drive',
          usage: 'tsubasa import drive <folderIdOrUrl> --dest <path> --source-auth <cred.json>',
          description: 'Import an external Google Drive folder tree with MD5 verification and multi-day 750 GB resume.',
          flags: [
            { name: '--dest', arg: '<path>', description: 'Target virtual directory path (supports <slug>:/path).' },
            { name: '--source-auth', arg: '<cred.json>', description: 'External source OAuth client credentials file.' },
            { name: '--mode', arg: '<copy|stream>', description: 'Transfer mode: temporary folder shares (copy) or streaming (stream).' },
            { name: '--conflict', arg: '<skip|reject|replace|keep_both>', description: 'Collision policy (default skip).' },
            { name: '--no-browser', description: 'Print source OAuth URL without launching a browser.' },
            { name: '--detach', description: 'Start import and return jobId immediately (HTTP mode only).' },
          ],
        },
        {
          name: 'tokens',
          usage: 'tsubasa import tokens <list|clear>',
          description: 'List or clear cached external source OAuth tokens in data/source-tokens/.',
        },
      ],
    },
    {
      name: 'plan',
      usage: 'tsubasa plan <upload|import-drive> [args...]',
      description: 'Simulate upload or external Drive import placement without writing changes.',
      subcommands: [
        { name: 'upload', usage: 'tsubasa plan upload <local-path> <remote-path>', description: 'Thin alias for upload --dry-run.' },
        {
          name: 'import-drive',
          usage: 'tsubasa plan import-drive <folderIdOrUrl> --dest <path> --source-auth <cred.json>',
          description: 'Thin alias for import drive --dry-run.',
        },
      ],
    },
  ],
};

export function serializeHelpSchema(pretty = false): string {
  return JSON.stringify(CLI_HELP_SCHEMA, null, pretty ? 2 : undefined);
}
