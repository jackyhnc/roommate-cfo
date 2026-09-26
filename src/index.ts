import { warmup } from './amazon.ts'
import { runCli } from './transports/cli.ts'
import { runIMessage } from './transports/imessage.ts'

warmup()

if (process.argv.includes('--cli')) await runCli()
else await runIMessage()
