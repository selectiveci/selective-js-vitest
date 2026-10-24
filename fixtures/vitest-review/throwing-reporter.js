export default class ThrowingReporter {
  onTestRunEnd() {
    throw new Error("reporter boom");
  }
}
