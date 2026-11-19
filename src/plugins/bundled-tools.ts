// Optional descriptors only. No tool is downloaded, registered or granted permissions by discovery.
import ckbCli from '../../tools/ckb-cli.json';

export const bundledTools: Readonly<Record<string, unknown>> = { 'ckb-cli': ckbCli };
