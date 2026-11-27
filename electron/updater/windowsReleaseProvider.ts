import type { CustomPublishOptions } from 'builder-util-runtime';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import { resolveFiles, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';

export class WindowsReleaseProvider extends GenericProvider {
  private readonly releases: URL;

  constructor(options: CustomPublishOptions, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    const releases = new URL(`https://github.com/${options.repo}/releases/`);
    // GitHub release assets accept single ranges but can reject multipart ranges with HTTP 501.
    super(
      { provider: 'generic', url: new URL('latest/download/', releases).href },
      updater,
      { ...runtime, isUseMultipleRangeRequest: false },
    );
    this.releases = releases;
  }

  override resolveFiles(info: UpdateInfo) {
    // The updater substitutes the installed version in this path for a missing old
    // blockmap. A versioned path selects the old tag as well as the old filename.
    return resolveFiles(info, new URL(`download/v${encodeURIComponent(info.version)}/`, this.releases));
  }
}
