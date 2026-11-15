import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from './video.entity';
import { VideoStatus } from '../video-status.enum';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let sequence = 0;

  const buildVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    public_id: `vid${String(++sequence).padStart(8, '0')}`,
    channel_id: channel.id,
    source_key: 'videos/placeholder/source.mp4',
    ...overrides,
  });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@test.dev', password: 'hash' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'owner',
      user_id: user.id,
    });
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  it('should default status to draft and accept a null title', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.title).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'abcdefghijk' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'abcdefghijk' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a video whose channel_id does not exist', async () => {
    await expect(
      videoRepository.save(
        buildVideo({ channel_id: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a status value outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos (public_id, channel_id, source_key, status)
         VALUES ('zzzzzzzzzzz', $1, 'k', 'archived')`,
        [channel.id],
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should map bigint and numeric columns to numbers', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: 10737418240, duration_seconds: 240.5 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(10737418240);
    expect(found.duration_seconds).toBe(240.5);
  });

  it('should expose the inverse side through Channel.videos', async () => {
    await videoRepository.save(buildVideo());

    const found = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { id: channel.id }, relations: ['videos'] });
    expect(found.videos).toHaveLength(1);
  });
});
