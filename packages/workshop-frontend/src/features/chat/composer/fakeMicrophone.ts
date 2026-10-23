// Vitest runs under node, but the src/ tsconfig only has browser types.
// @ts-expect-error node builtin without @types/node
import { Blob as NodeBlob } from "node:buffer";
import { onTestFinished, vi, type Mock } from "vitest";

// A MediaRecorder for jsdom, which has none. Like a real one, it delivers its events
// asynchronously, and hands over whatever it still holds when stopped.
class FakeMediaRecorder extends EventTarget {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";

  state: RecordingState = "inactive";

  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions,
      recorders: FakeMediaRecorder[]) {
    super();
    recorders.push(this);
  }

  start() {
    this.state = "recording";
  }

  /** Delivers a chunk, as a real recorder does once per timeslice. */
  emit(bytes: Uint8Array<ArrayBuffer>) {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([bytes]) }));
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      this.emit(FINAL_CHUNK);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

/** The bytes every fake recorder hands over when it stops. */
export const FINAL_CHUNK = new Uint8Array([0xff]);

/**
 * A microphone and MediaRecorder installed in jsdom. `recorders` lists every recorder made,
 * `stream` is what `getUserMedia` grants, and `track.stop` reports whether the microphone was
 * released.
 */
export type FakeMicrophone = {
  recorders: FakeMediaRecorder[];
  stream: MediaStream;
  track: { stop: Mock<() => void> };
  getUserMedia: Mock<(constraints: MediaStreamConstraints) => Promise<MediaStream>>;
};

// Defines `target[key]` until the current test finishes.
const replaceForTest = (target: object, key: string, value: unknown) => {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  onTestFinished(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
};

/** Installs a microphone and MediaRecorder in jsdom for the current test. */
export const installFakeMicrophone = (): FakeMicrophone => {
  const recorders: FakeMediaRecorder[] = [];
  const track = { stop: vi.fn<() => void>() };
  // Only getTracks() is read from the stream.
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  replaceForTest(globalThis, "MediaRecorder", class extends FakeMediaRecorder {
    constructor(stream: MediaStream, options: MediaRecorderOptions) {
      super(stream, options, recorders);
    }
  });
  // jsdom's Blob has no arrayBuffer(), which is how the recording is read.
  replaceForTest(globalThis, "Blob", NodeBlob);
  replaceForTest(navigator, "mediaDevices", { getUserMedia });
  return { recorders, stream, track, getUserMedia };
};
