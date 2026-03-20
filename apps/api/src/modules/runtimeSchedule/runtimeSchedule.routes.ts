import { Router } from 'express';
import { logger } from '../../common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import {
  getRuntimeScheduleSnapshot,
  isValidDailyTime,
  saveRuntimeSchedule
} from '@shared/utils/runtimeSchedule.js';

const router = Router();

router.get('/api/runtime-schedule', async (_req, res, next) => {
  try {
    const data = await getRuntimeScheduleSnapshot();
    return res.json({ ok: true, data });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/runtime-schedule', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pullTime = typeof body.pullTime === 'string' ? body.pullTime.trim() : '';
    const pushTime = typeof body.pushTime === 'string' ? body.pushTime.trim() : '';

    if (!isValidDailyTime(pullTime)) {
      return res.status(400).json({ ok: false, error: 'invalid_pull_time' });
    }
    if (!isValidDailyTime(pushTime)) {
      return res.status(400).json({ ok: false, error: 'invalid_push_time' });
    }

    const data = await saveRuntimeSchedule({
      pull_time: pullTime,
      push_time: pushTime
    });

    await writeOperationLog(
      {
        source: 'api.runtime_schedule',
        action: 'save_runtime_schedule',
        target_type: 'runtime_schedule',
        target_key: data.singleton_key,
        status: 'success',
        summary: `更新全局调度：Pull ${data.pull_time} / Push ${data.push_time}`,
        detail_json: data
      },
      logger
    );

    return res.json({ ok: true, data });
  } catch (error) {
    return next(error);
  }
});

export default router;
