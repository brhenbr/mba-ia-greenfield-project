import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';

// Root module of the video worker: same codebase as the API, no HTTP server.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    // With autoLoadEntities, TypeORM only knows registered entities: Video
    // references Channel, which references User, so the whole chain is listed.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
  ],
  providers: [VideosService, MediaProbeService, VideoProcessingProcessor],
})
export class WorkerModule {}
