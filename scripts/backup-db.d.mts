export type BackupFdStat = {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
};

export type BackupSqliteDatabaseOptions = {
  _duringSerialize?: (parentDir: string, destinationPath: string) => void | Promise<void>;
  _beforeParentStagePin?: (tmpPath: string) => void | Promise<void>;
  _beforeSqliteOpen?: (tmpPath: string, helperPid?: number) => void | Promise<void>;
  _sqliteOpenHookUrl?: string;
  _duringTransferHookUrl?: string;
  _disablePpidSelfExit?: boolean;
  _afterTempFileWritten?: (tmpPath: string, fdStat: BackupFdStat, helperPid?: number) => void | Promise<void>;
  _beforeLinkAt?: (tmpBase: string, parentDir: string) => void | Promise<void>;
  _betweenPreLinkStatAndLink?: (tmpPath: string, fdStat: BackupFdStat) => void | Promise<void>;
  _afterLinkAt?: (destinationPath: string) => void | Promise<void>;
  _beforeAbortCleanup?: (tmpPath: string, fdStat: BackupFdStat) => void | Promise<void>;
};

export function backupSqliteDatabase(
  sourcePathArg: string,
  destinationPathArg: string,
  options?: BackupSqliteDatabaseOptions,
): Promise<string>;
