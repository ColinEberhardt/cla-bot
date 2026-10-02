const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});

const loggedMessages = [];
let logFile = null;

const logMessage = (level, message, detail) => {
  const logData = [new Date().toISOString(), level, message];
  // super crude filtering! these logs are displayed externally to end users
  // so we need to be v. careful about what is included.
  if (level !== "DEBUG") {
    loggedMessages.push(logData.join(" "));
  }
  if (detail !== undefined) {
    logData.push(JSON.stringify(detail));
  }
  console.info(logData.join(" "));
};

const logger = {
  debug(message, detail) {
    logMessage("DEBUG", message, detail);
  },
  info(message, detail) {
    logMessage("INFO", message, detail);
  },
  error(message, detail) {
    logMessage("ERROR", message, detail);
  },
  // module state survives between invocations of a warm lambda, so this
  // must be called at the start of every invocation
  reset() {
    loggedMessages.length = 0;
    logFile = null;
  },
  logFile(filename) {
    loggedMessages.length = 0;
    logFile = filename;
  },
  // writes the user-facing log to S3, but only if this invocation performed
  // a CLA check (i.e. logFile was set)
  async flush() {
    if (process.env.JASMINE || !logFile) {
      return;
    }

    await s3.send(
      new PutObjectCommand({
        Body: loggedMessages.join("\r\n"),
        Bucket: process.env.LOGGING_BUCKET,
        Key: logFile,
        ACL: "public-read",
        ContentType: "text/plain"
      })
    );
  }
};

module.exports = logger;
