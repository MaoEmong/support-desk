import { describe, expect, it } from 'vitest';
import { validateResetTarget } from '../src/reset';

describe('seed reset target safety', () => {
  it('accepts only a local explicitly named e2e database and uses a separate maintenance DB', () => {
    const target = validateResetTarget('postgresql://localhost:55432/support_stage2_e2e');
    expect(target.database).toBe('support_stage2_e2e');
    expect(new URL(target.maintenanceUrl).pathname).toBe('/postgres');
  });
  it.each([
    'postgresql://localhost/support_desk', 'postgresql://localhost/postgres',
    'postgresql://remote.example/support_e2e', 'postgresql://localhost/support_e2e?database=production',
    'postgresql://localhost/support_e2e?host=remote.example', 'postgresql://localhost/support_e2e#override',
    'postgresql://localhost/support%22_e2e', 'postgresql://localhost/support%2Fe2e',
    'https://localhost/support_e2e',
  ])('rejects unsafe reset target %s', input => {
    expect(() => validateResetTarget(input)).toThrow('--reset requires');
  });
});
