import { VideoMaintenanceProcessor } from './video-maintenance.processor';

describe('VideoMaintenanceProcessor', () => {
  const maintenanceService = {
    reenqueueStuckProcessing: jest.fn(),
    cleanupAbandonedDrafts: jest.fn(),
  };
  let processor: VideoMaintenanceProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    maintenanceService.reenqueueStuckProcessing.mockResolvedValue(2);
    maintenanceService.cleanupAbandonedDrafts.mockResolvedValue(1);
    processor = new VideoMaintenanceProcessor(maintenanceService as never);
  });

  it('should run both routines on every sweep', async () => {
    await expect(processor.process()).resolves.toBeUndefined();

    expect(maintenanceService.reenqueueStuckProcessing).toHaveBeenCalledTimes(
      1,
    );
    expect(maintenanceService.cleanupAbandonedDrafts).toHaveBeenCalledTimes(1);
  });

  it('should still clean up drafts when the re-enqueue routine fails', async () => {
    maintenanceService.reenqueueStuckProcessing.mockRejectedValue(
      new Error('redis down'),
    );

    await expect(processor.process()).rejects.toThrow(
      /reenqueueStuckProcessing.*redis down/,
    );

    expect(maintenanceService.cleanupAbandonedDrafts).toHaveBeenCalledTimes(1);
  });

  it('should still re-enqueue when the draft cleanup fails', async () => {
    maintenanceService.cleanupAbandonedDrafts.mockRejectedValue(
      new Error('storage down'),
    );

    await expect(processor.process()).rejects.toThrow(
      /cleanupAbandonedDrafts.*storage down/,
    );

    expect(maintenanceService.reenqueueStuckProcessing).toHaveBeenCalledTimes(
      1,
    );
  });

  it('should report both failures when both routines fail', async () => {
    maintenanceService.reenqueueStuckProcessing.mockRejectedValue(
      new Error('a'),
    );
    maintenanceService.cleanupAbandonedDrafts.mockRejectedValue(new Error('b'));

    await expect(processor.process()).rejects.toThrow(
      /reenqueueStuckProcessing.*cleanupAbandonedDrafts/,
    );
  });
});
