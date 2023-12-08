import { Runnable, RunnableBatchOptions } from "../schema/runnable/index.js";
import { RunnableConfig } from "../schema/runnable/config.js";
import {
  BaseCallbackConfig,
  CallbackManagerForChainRun,
} from "../callbacks/manager.js";
import {
  convertEventStreamToIterableReadableDataStream,
  getBytes,
  getLines,
  getMessages,
} from "../util/event-source-parse.js";
import { Document } from "../document.js";
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessage,
  FunctionMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  SystemMessage,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
} from "../schema/index.js";
import { StringPromptValue } from "../prompts/base.js";
import { ChatPromptValue } from "../prompts/chat.js";
import { IterableReadableStream } from "../util/stream.js";
import {
  LogStreamCallbackHandler,
  LogStreamCallbackHandlerInput,
  RunLogPatch,
} from "../callbacks/handlers/log_stream.js";

type RemoteRunnableOptions = {
  timeout?: number;
};

function isSuperset(set: Set<string>, subset: Set<string>) {
  for (const elem of subset) {
    if (!set.has(elem)) {
      return false;
    }
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function revive(obj: any): any {
  if (Array.isArray(obj)) return obj.map(revive);
  if (typeof obj === "object") {
    const keysArr = Object.keys(obj);
    const keys = new Set(keysArr);
    if (isSuperset(keys, new Set(["page_content", "metadata"])))
      return new Document({
        pageContent: obj.page_content,
        metadata: obj.metadata,
      });

    if (isSuperset(keys, new Set(["content", "type", "is_chunk"]))) {
      if (!obj.is_chunk) {
        if (obj.type === "human") {
          return new HumanMessage({
            content: obj.content,
          });
        }
        if (obj.type === "system") {
          return new SystemMessage({
            content: obj.content,
          });
        }
        if (obj.type === "chat") {
          return new ChatMessage({
            content: obj.content,
            role: obj.role,
          });
        }
        if (obj.type === "function") {
          return new FunctionMessage({
            content: obj.content,
            name: obj.name,
          });
        }
        if (obj.type === "tool") {
          return new ToolMessage({
            content: obj.content,
            tool_call_id: obj.tool_call_id,
          });
        }
        if (obj.type === "ai") {
          return new AIMessage({
            content: obj.content,
          });
        }
      } else {
        if (obj.type === "human") {
          return new HumanMessageChunk({
            content: obj.content,
          });
        }
        if (obj.type === "system") {
          return new SystemMessageChunk({
            content: obj.content,
          });
        }
        if (obj.type === "chat") {
          return new ChatMessageChunk({
            content: obj.content,
            role: obj.role,
          });
        }
        if (obj.type === "function") {
          return new FunctionMessageChunk({
            content: obj.content,
            name: obj.name,
          });
        }
        if (obj.type === "tool") {
          return new ToolMessageChunk({
            content: obj.content,
            tool_call_id: obj.tool_call_id,
          });
        }
        if (obj.type === "ai") {
          return new AIMessageChunk({
            content: obj.content,
          });
        }
      }
    }
    if (isSuperset(keys, new Set(["text"]))) {
      return new StringPromptValue(obj.text);
    }
    if (isSuperset(keys, new Set(["messages"]))) {
      return new ChatPromptValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: obj.messages.map((msg: any) => revive(msg)),
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerRevive: (key: string) => [string, any] = (key: string) => [
      key,
      revive(obj[key]),
    ];
    const rtn = Object.fromEntries(keysArr.map(innerRevive));
    return rtn;
  }
  return obj;
}
function deserialize<RunOutput>(str: string): RunOutput {
  const obj = JSON.parse(str);
  return revive(obj);
}

function removeCallbacks(
  options?: RunnableConfig
): Omit<RunnableConfig, "callbacks"> {
  const rest = { ...options };
  delete rest.callbacks;
  return rest;
}

export class RemoteRunnable<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig
> extends Runnable<RunInput, RunOutput, CallOptions> {
  private url: string;

  private options?: RemoteRunnableOptions;

  lc_namespace = ["langchain", "schema", "runnable", "remote"];

  constructor(fields: { url: string; options?: RemoteRunnableOptions }) {
    super(fields);
    const { url, options } = fields;
    this.url = url.replace(/\/$/, ""); // remove trailing slash
    this.options = options;
  }

  private async post<Body>(path: string, body: Body) {
    return await fetch(`${this.url}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(this.options?.timeout ?? 5000),
    });
  }

  async invoke(
    input: RunInput,
    options?: Partial<CallOptions>
  ): Promise<RunOutput> {
    const [config, kwargs] =
      this._separateRunnableConfigFromCallOptions(options);
    const response = await this.post<{
      input: RunInput;
      config?: RunnableConfig;
      kwargs?: Omit<Partial<CallOptions>, keyof BaseCallbackConfig>;
    }>("/invoke", {
      input,
      config: removeCallbacks(config),
      kwargs: kwargs ?? {},
    });
    return revive((await response.json()).output) as RunOutput;
  }

  async _batch(
    inputs: RunInput[],
    options?: Partial<CallOptions>[],
    _?: (CallbackManagerForChainRun | undefined)[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]> {
    if (batchOptions?.returnExceptions) {
      throw new Error("returnExceptions is not supported for remote clients");
    }
    const configsAndKwargsArray = options?.map((opts) =>
      this._separateRunnableConfigFromCallOptions(opts)
    );
    const [configs, kwargs] = configsAndKwargsArray?.reduce(
      ([pc, pk], [c, k]) =>
        [
          [...pc, c],
          [...pk, k],
        ] as [
          RunnableConfig[],
          Omit<Partial<CallOptions>, keyof BaseCallbackConfig>[]
        ],
      [[], []] as [
        RunnableConfig[],
        Omit<Partial<CallOptions>, keyof BaseCallbackConfig>[]
      ]
    ) ?? [undefined, undefined];
    const response = await this.post<{
      inputs: RunInput[];
      config?: (RunnableConfig & RunnableBatchOptions)[];
      kwargs?: Omit<Partial<CallOptions>, keyof BaseCallbackConfig>[];
    }>("/batch", {
      inputs,
      config: (configs ?? [])
        .map(removeCallbacks)
        .map((config) => ({ ...config, ...batchOptions })),
      kwargs,
    });
    const body = await response.json();

    if (!body.output) throw new Error("Invalid response from remote runnable");

    return revive(body.output);
  }

  async batch(
    inputs: RunInput[],
    options?: Partial<CallOptions> | Partial<CallOptions>[],
    batchOptions?: RunnableBatchOptions & { returnExceptions?: false }
  ): Promise<RunOutput[]>;

  async batch(
    inputs: RunInput[],
    options?: Partial<CallOptions> | Partial<CallOptions>[],
    batchOptions?: RunnableBatchOptions & { returnExceptions: true }
  ): Promise<(RunOutput | Error)[]>;

  async batch(
    inputs: RunInput[],
    options?: Partial<CallOptions> | Partial<CallOptions>[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]>;

  async batch(
    inputs: RunInput[],
    options?: Partial<CallOptions> | Partial<CallOptions>[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]> {
    if (batchOptions?.returnExceptions) {
      throw Error("returnExceptions is not supported for remote clients");
    }
    return this._batchWithConfig(
      this._batch.bind(this),
      inputs,
      options,
      batchOptions
    );
  }

  async stream(
    input: RunInput,
    options?: Partial<CallOptions>
  ): Promise<IterableReadableStream<RunOutput>> {
    const [config, kwargs] =
      this._separateRunnableConfigFromCallOptions(options);
    const response = await this.post<{
      input: RunInput;
      config?: RunnableConfig;
      kwargs?: Omit<Partial<CallOptions>, keyof BaseCallbackConfig>;
    }>("/stream", {
      input,
      config,
      kwargs,
    });
    if (!response.ok) {
      const json = await response.json();
      const error = new Error(
        `RemoteRunnable call failed with status code ${response.status}: ${json.message}`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any).response = response;
      throw error;
    }
    const { body } = response;
    if (!body) {
      throw new Error(
        "Could not begin remote stream. Please check the given URL and try again."
      );
    }
    const stream = new ReadableStream({
      async start(controller) {
        const enqueueLine = getMessages((msg) => {
          if (msg.data) controller.enqueue(deserialize(msg.data));
        });
        const onLine = (
          line: Uint8Array,
          fieldLength: number,
          flush?: boolean
        ) => {
          enqueueLine(line, fieldLength, flush);
          if (flush) controller.close();
        };
        await getBytes(body, getLines(onLine));
      },
    });
    return IterableReadableStream.fromReadableStream(stream);
  }

  async *streamLog(
    input: RunInput,
    options?: Partial<CallOptions>,
    streamOptions?: Omit<LogStreamCallbackHandlerInput, "autoClose">
  ): AsyncGenerator<RunLogPatch> {
    const [config, kwargs] =
      this._separateRunnableConfigFromCallOptions(options);
    const stream = new LogStreamCallbackHandler({
      ...streamOptions,
      autoClose: false,
    });
    const { callbacks } = config;
    if (callbacks === undefined) {
      config.callbacks = [stream];
    } else if (Array.isArray(callbacks)) {
      config.callbacks = callbacks.concat([stream]);
    } else {
      const copiedCallbacks = callbacks.copy();
      copiedCallbacks.inheritableHandlers.push(stream);
      config.callbacks = copiedCallbacks;
    }
    const getExtraOptionsFromInput = () => {
      const optionKeys = [
        "diff",
        "include_names",
        "include_types",
        "include_tags",
        "exclude_names",
        "exclude_types",
        "exclude_tags",
      ];
      const extraOptions: Record<string, unknown> = {
        diff: true,
      };
      for (const key of optionKeys) {
        const keyAsKeyof = key as keyof RunInput;
        if (input[keyAsKeyof] !== undefined && input[keyAsKeyof] !== null) {
          // Do not allow diff=false.
          if (keyAsKeyof === "diff" && input[keyAsKeyof] === false) {
            throw new Error(
              "Diff defaults to true and cannot be set to false for stream log."
            );
          }
          extraOptions[key] = input[keyAsKeyof];
        }
      }
      return extraOptions;
    };
    const response = await this.post<{
      input: RunInput;
      config?: RunnableConfig;
      kwargs?: Omit<Partial<CallOptions>, keyof BaseCallbackConfig>;
      diff?: boolean;
      include_names?: Array<string>;
      include_types?: Array<string>;
      include_tags?: Array<string>;
      exclude_names?: Array<string>;
      exclude_types?: Array<string>;
      exclude_tags?: Array<string>;
    }>("/stream_log", {
      input,
      config,
      kwargs,
      ...getExtraOptionsFromInput(),
    });
    const { body } = response;
    if (!body) {
      throw new Error(
        "Could not begin remote stream log. Please check the given URL and try again."
      );
    }
    const runnableStream = convertEventStreamToIterableReadableDataStream(body);
    async function consumeRunnableStream() {
      try {
        for await (const chunk of runnableStream) {
          const patch = new RunLogPatch({
            ops: [
              {
                op: "add",
                path: "/streamed_output/-",
                value: chunk,
              },
            ],
          });
          await stream.writer.write(patch);
        }
      } finally {
        await stream.writer.close();
      }
    }
    const runnableStreamPromise = consumeRunnableStream();
    try {
      for await (const log of stream) {
        yield log;
      }
    } finally {
      await runnableStreamPromise;
    }
  }
}
