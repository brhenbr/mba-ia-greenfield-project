import { Test } from '@nestjs/testing';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the processor and its collaborators', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(moduleRef.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);

    await moduleRef.close();
  });
});
