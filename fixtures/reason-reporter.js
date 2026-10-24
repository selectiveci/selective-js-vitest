import fs from "node:fs";

export default class ReasonReporter {
  onTestRunEnd(_testModules, _errors, reason) {
    const file = process.env.SELECTIVE_REASON_OUT;
    if (file) fs.writeFileSync(file, String(reason));
  }
}
