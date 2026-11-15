import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Entry point of the video worker container: a standalone application context
// (no HTTP server). Shutdown hooks let BullMQ close the worker gracefully, so
// in-flight jobs are not marked as stalled.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker is running');
}
void bootstrap();
