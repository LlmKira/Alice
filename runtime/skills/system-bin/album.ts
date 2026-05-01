/**
 * album — Alice group photo album CLI.
 *
 * @see docs/adr/260-group-photo-album-affordance/README.md
 */

import { runMain } from "citty";
import { albumCommand } from "../../src/system/album-cli.ts";

await runMain(albumCommand);
