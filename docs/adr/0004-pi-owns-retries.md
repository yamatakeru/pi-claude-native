# Pi decides which failures to retry

Claude Native is a Pi provider, and Pi's auto-retry decides from the error text alone whether to retry. #99 kept failures after the request was sent out of Pi's retries, because Anthropic may already be generating and a retry could use plan allowance twice. That rule depended on Pi not matching the text. Pi 1.6.0 retries bare socket codes such as `ECONNRESET` and `ETIMEDOUT` ([earendil-works/pi#12128](https://github.com/earendil-works/pi/issues/12128)), and the relay's failure text names them, so the rule no longer held (#106).

## Decision

Error texts describe the failure truthfully, and Pi's classifier decides the retry. The provider does not word a failure to get or to avoid a retry. The unsent note (`[upstream connect failed before the request was sent]`) stays: it states a fact, and it makes an unsent failure retryable on Pi before 1.6.0 and for codes Pi does not list.

## Considered options

- **Keeping #99's rule by removing the Node code from post-send failures.** This hides the cause from the user, and it repeats what #100 was about: a retry decided by wording that a Pi release can change at any time. Rejected.
- **Classifying in the provider and marking a failure non-retryable**, for example with `billing`, which Pi never retries. That word would mislead the user, and Pi has no field for retryability. Rejected.

## Consequences

- Pi already retried the same failures from its own Anthropic provider in 1.5.2. Against a loopback upstream that read the request and reset, and one that sent a complete `tool_use` block and then reset, it reported `Connection error.: other side closed` and `terminated: other side closed`, both retryable. Claude Native now matches it.
- A post-send retry can use plan allowance twice. At Pi's defaults (3 retries), one turn makes at most 4 attempts. Each attempt sends one upstream request, or two when the first is answered with a 401 authentication error, so a turn sends at most 8. Against a loopback upstream that reset every request, a turn sent 4. Users who want no such retries turn off Pi's auto-retry.
- A retry cannot run a tool twice. Tool calls are published only after a complete response, and Pi leaves the failed attempt out of the retried request. A loopback upstream that sent a complete `tool_use` block and then reset confirmed that no tool ran.
- Anthropic processes a request whose connection failed silently or closed after the response started, so the retry duplicates it, reading the input from the cache. A close Anthropic sees before the response starts left no trace of the request in the cache. Whether plan usage counts these requests is not verified ([measurements](../transport-measurements.md#whether-anthropic-processes-a-request-whose-connection-broke-106)).
