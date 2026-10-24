import inspector from "node:inspector/promises";

inspector.Session.prototype.post = async function post() {
  throw new Error("inspector stubbed to fail");
};
