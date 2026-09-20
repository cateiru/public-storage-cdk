import { afterAll } from 'vitest';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';

// CDK synth時に作られる一時ディレクトリをテスト後に掃除する
// (aws-cdk-lib/testhelpers/jest-autoclean の Vitest 版)
afterAll(() => {
  CloudAssembly.cleanupTemporaryDirectories();
});
