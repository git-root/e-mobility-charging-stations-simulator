// Copyright Jerome Benoit. 2021-2024. All Rights Reserved.

import { URL } from 'node:url'

import {
  DBName,
  type EmptyObject,
  type HandleErrorParams,
  type Statistics,
  StorageType
} from '../../types/index.js'
import { logger, setDefaultErrorParams } from '../../utils/index.js'

export abstract class Storage {
  protected readonly storageUri: URL
  protected readonly logPrefix: string
  protected dbName!: string

  constructor (storageUri: string, logPrefix: string) {
    this.storageUri = new URL(storageUri)
    this.logPrefix = logPrefix
  }

  protected handleDBError (
    type: StorageType,
    error: Error,
    table?: string,
    params: HandleErrorParams<EmptyObject> = { throwError: false, consoleOut: false }
  ): void {
    setDefaultErrorParams(params, { throwError: false, consoleOut: false })
    const inTableOrCollectionStr = table != null && ` in table or collection '${table}'`
    logger.error(
      `${this.logPrefix} ${this.getDBNameFromStorageType(type)} error '${
        error.message
      }'${inTableOrCollectionStr}:`,
      error
    )
    if (params.throwError === true) {
      throw error
    }
  }

  protected getDBNameFromStorageType (type: StorageType): DBName | undefined {
    switch (type) {
      case StorageType.SQLITE:
        return DBName.SQLITE
      case StorageType.MARIA_DB:
        return DBName.MARIA_DB
      case StorageType.MYSQL:
        return DBName.MYSQL
      case StorageType.MONGO_DB:
        return DBName.MONGO_DB
    }
  }

  public abstract open (): void | Promise<void>
  public abstract close (): void | Promise<void>
  public abstract storePerformanceStatistics (
    performanceStatistics: Statistics
  ): void | Promise<void>
}
