// Partial Copyright Jerome Benoit. 2021-2024. All Rights Reserved.

import { type PerformanceEntry, PerformanceObserver, performance } from 'node:perf_hooks'
import type { URL } from 'node:url'
import { parentPort } from 'node:worker_threads'

import { secondsToMilliseconds } from 'date-fns'

import { BaseError } from '../exception/index.js'
import {
  ConfigurationSection,
  type IncomingRequestCommand,
  type LogConfiguration,
  MessageType,
  type RequestCommand,
  type Statistics,
  type StorageConfiguration,
  type TimestampedData
} from '../types/index.js'
import {
  CircularArray,
  Configuration,
  Constants,
  JSONStringifyWithMapSupport,
  average,
  buildPerformanceStatisticsMessage,
  extractTimeSeriesValues,
  formatDurationSeconds,
  generateUUID,
  logPrefix,
  logger,
  max,
  median,
  min,
  nthPercentile,
  stdDeviation
} from '../utils/index.js'

export class PerformanceStatistics {
  private static readonly instances: Map<string, PerformanceStatistics> = new Map<
  string,
  PerformanceStatistics
  >()

  private readonly objId: string | undefined
  private readonly objName: string | undefined
  private performanceObserver!: PerformanceObserver
  private readonly statistics: Statistics
  private displayInterval?: NodeJS.Timeout

  private constructor (objId: string, objName: string, uri: URL) {
    this.objId = objId
    this.objName = objName
    this.initializePerformanceObserver()
    this.statistics = {
      id: this.objId,
      name: this.objName,
      uri: uri.toString(),
      createdAt: new Date(),
      statisticsData: new Map()
    }
  }

  public static getInstance (
    objId: string | undefined,
    objName: string | undefined,
    uri: URL | undefined
  ): PerformanceStatistics | undefined {
    const logPfx = logPrefix(' Performance statistics')
    if (objId == null) {
      const errMsg = 'Cannot get performance statistics instance without specifying object id'
      logger.error(`${logPfx} ${errMsg}`)
      throw new BaseError(errMsg)
    }
    if (objName == null) {
      const errMsg = 'Cannot get performance statistics instance without specifying object name'
      logger.error(`${logPfx} ${errMsg}`)
      throw new BaseError(errMsg)
    }
    if (uri == null) {
      const errMsg = 'Cannot get performance statistics instance without specifying object uri'
      logger.error(`${logPfx} ${errMsg}`)
      throw new BaseError(errMsg)
    }
    if (!PerformanceStatistics.instances.has(objId)) {
      PerformanceStatistics.instances.set(objId, new PerformanceStatistics(objId, objName, uri))
    }
    return PerformanceStatistics.instances.get(objId)
  }

  public static beginMeasure (id: string): string {
    const markId = `${id.charAt(0).toUpperCase()}${id.slice(1)}~${generateUUID()}`
    performance.mark(markId)
    return markId
  }

  public static endMeasure (name: string, markId: string): void {
    try {
      performance.measure(name, markId)
    } catch (error) {
      if (error instanceof Error && error.message.includes('performance mark has not been set')) {
        /* Ignore */
      } else {
        throw error
      }
    }
    performance.clearMarks(markId)
    performance.clearMeasures(name)
  }

  public addRequestStatistic (
    command: RequestCommand | IncomingRequestCommand,
    messageType: MessageType,
    messageSize?: int
  ): void {
    switch (messageType) {
      case MessageType.CALL_MESSAGE:
        if (
          this.statistics.statisticsData.has(command) &&
          this.statistics.statisticsData.get(command)?.requestCount != null
        ) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ++this.statistics.statisticsData.get(command)!.requestCount!
        } else {
          if(typeof messageSize !== 'undefined'){
          this.statistics.statisticsData.set(command, {
            ...this.statistics.statisticsData.get(command),
            requestCount: 1,
            messageSize: messageSize 
          })
          } else {
          this.statistics.statisticsData.set(command, {
            ...this.statistics.statisticsData.get(command),
            requestCount: 1
          })
	
}
        }
        break
      case MessageType.CALL_RESULT_MESSAGE:
        if (
          this.statistics.statisticsData.has(command) &&
          this.statistics.statisticsData.get(command)?.responseCount != null
        ) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ++this.statistics.statisticsData.get(command)!.responseCount!
        } else {
          this.statistics.statisticsData.set(command, {
            ...this.statistics.statisticsData.get(command),
            responseCount: 1
          })
        }
        break
      case MessageType.CALL_ERROR_MESSAGE:
        if (
          this.statistics.statisticsData.has(command) &&
          this.statistics.statisticsData.get(command)?.errorCount != null
        ) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ++this.statistics.statisticsData.get(command)!.errorCount!
        } else {
          this.statistics.statisticsData.set(command, {
            ...this.statistics.statisticsData.get(command),
            errorCount: 1
          })
        }
        break
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        logger.error(`${this.logPrefix()} wrong message type ${messageType}`)
        break
    }
  }

  public start (): void {
    this.startLogStatisticsInterval()
    const performanceStorageConfiguration =
      Configuration.getConfigurationSection<StorageConfiguration>(
        ConfigurationSection.performanceStorage
      )
    if (performanceStorageConfiguration.enabled === true) {
      logger.info(
        `${this.logPrefix()} storage enabled: type ${performanceStorageConfiguration.type}, uri: ${
          performanceStorageConfiguration.uri
        }`
      )
    }
  }

  public stop (): void {
    this.stopLogStatisticsInterval()
    performance.clearMarks()
    performance.clearMeasures()
    this.performanceObserver.disconnect()
  }

  public restart (): void {
    this.stop()
    this.start()
  }

  private initializePerformanceObserver (): void {
    this.performanceObserver = new PerformanceObserver(performanceObserverList => {
      const lastPerformanceEntry = performanceObserverList.getEntries()[0]
      // logger.debug(
      //   `${this.logPrefix()} '${lastPerformanceEntry.name}' performance entry: %j`,
      //   lastPerformanceEntry
      // )
      this.addPerformanceEntryToStatistics(lastPerformanceEntry)
    })
    this.performanceObserver.observe({ entryTypes: ['measure'] })
  }

  private logStatistics (): void {
    logger.info(this.logPrefix(), {
      ...this.statistics,
      statisticsData: JSONStringifyWithMapSupport(this.statistics.statisticsData)
    })
  }

  private startLogStatisticsInterval (): void {
    const logConfiguration = Configuration.getConfigurationSection<LogConfiguration>(
      ConfigurationSection.log
    )
    const logStatisticsInterval =
      logConfiguration.enabled === true
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        logConfiguration.statisticsInterval!
        : 0
    if (logStatisticsInterval > 0 && this.displayInterval == null) {
      this.displayInterval = setInterval(() => {
        this.logStatistics()
      }, secondsToMilliseconds(logStatisticsInterval))
      logger.info(
        `${this.logPrefix()} logged every ${formatDurationSeconds(logStatisticsInterval)}`
      )
    } else if (this.displayInterval != null) {
      logger.info(
        `${this.logPrefix()} already logged every ${formatDurationSeconds(logStatisticsInterval)}`
      )
    } else if (logConfiguration.enabled === true) {
      logger.info(
        `${this.logPrefix()} log interval is set to ${logStatisticsInterval}. Not logging statistics`
      )
    }
  }

  private stopLogStatisticsInterval (): void {
    if (this.displayInterval != null) {
      clearInterval(this.displayInterval)
      delete this.displayInterval
    }
  }

  private addPerformanceEntryToStatistics (entry: PerformanceEntry): void {
    // Initialize command statistics
    if (!this.statistics.statisticsData.has(entry.name)) {
      this.statistics.statisticsData.set(entry.name, {})
    }
    // Update current statistics
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.timeMeasurementCount =
      (this.statistics.statisticsData.get(entry.name)?.timeMeasurementCount ?? 0) + 1
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.currentTimeMeasurement = entry.duration
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.minTimeMeasurement = min(
      entry.duration,
      this.statistics.statisticsData.get(entry.name)?.minTimeMeasurement ?? Infinity
    )
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.maxTimeMeasurement = max(
      entry.duration,
      this.statistics.statisticsData.get(entry.name)?.maxTimeMeasurement ?? -Infinity
    )
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.totalTimeMeasurement =
      (this.statistics.statisticsData.get(entry.name)?.totalTimeMeasurement ?? 0) + entry.duration
    this.statistics.statisticsData.get(entry.name)?.measurementTimeSeries instanceof CircularArray
      ? this.statistics.statisticsData
        .get(entry.name)
        ?.measurementTimeSeries?.push({ timestamp: entry.startTime, value: entry.duration })
      : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (this.statistics.statisticsData.get(entry.name)!.measurementTimeSeries =
          new CircularArray<TimestampedData>(Constants.DEFAULT_CIRCULAR_BUFFER_CAPACITY, {
            timestamp: entry.startTime,
            value: entry.duration
          }))
    const timeMeasurementValues = extractTimeSeriesValues(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.statistics.statisticsData.get(entry.name)!.measurementTimeSeries!
    )
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.avgTimeMeasurement =
      average(timeMeasurementValues)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.medTimeMeasurement =
      median(timeMeasurementValues)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.ninetyFiveThPercentileTimeMeasurement =
      nthPercentile(timeMeasurementValues, 95)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.statistics.statisticsData.get(entry.name)!.stdDevTimeMeasurement = stdDeviation(
      timeMeasurementValues,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.statistics.statisticsData.get(entry.name)!.avgTimeMeasurement
    )
    this.statistics.updatedAt = new Date()
    if (
      Configuration.getConfigurationSection<StorageConfiguration>(
        ConfigurationSection.performanceStorage
      ).enabled === true
    ) {
      parentPort?.postMessage(buildPerformanceStatisticsMessage(this.statistics))
    }
  }

  private readonly logPrefix = (): string => {
    return logPrefix(` ${this.objName} | Performance statistics`)
  }
}
