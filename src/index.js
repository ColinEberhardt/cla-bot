const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const contributionVerifier = require("./contributionVerifier");
const installationToken = require("./installationToken");
const is = require("is_js");
const uuid = require("uuid/v4");
const githubApi = require("./githubApi");
const logger = require("./logger");

const defaultConfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "default.json"))
);

const sortUnique = arr =>
  arr
    .sort((a, b) => a - b)
    .filter((value, index, self) => self.indexOf(value, index + 1) === -1);

const mergeGroupAction = webhook =>
  webhook.action === "checks_requested" &&
  webhook.merge_group &&
  webhook.merge_group.base_sha &&
  webhook.merge_group.head_sha;

const mergeGroupCompareUrl = webhook => {
  const { base_sha: baseSha, head_sha: headSha } = webhook.merge_group;
  return `${webhook.repository.url}/compare/${baseSha}...${headSha}`;
};

const validAction = webhook =>
  webhook.action === "opened" ||
  webhook.action === "synchronize" ||
  mergeGroupAction(webhook) ||
  // issues do not have a body.issue.pull_request property, whereas PRs do
  (webhook.action === "created" && webhook.issue.pull_request);

// depending on the event type, the way the location of the PR and issue URLs are different
const gitHubUrls = webhook =>
  webhook.action === "created"
    ? {
        pullRequest: webhook.issue.pull_request.url,
        issue: webhook.issue.url
      }
    : mergeGroupAction(webhook)
      ? {
          pullRequest: mergeGroupCompareUrl(webhook)
        }
      : {
          pullRequest: webhook.pull_request.url,
          issue: webhook.pull_request.issue_url
        };

const commentSummonsBot = comment =>
  comment.match(new RegExp(`@${process.env.BOT_NAME}(\\[bot\\])?\\s*check`)) !==
  null;

const obtainToken = async webhook => {
  // if we are running as an integration, obtain the required integration token
  if (
    process.env.INTEGRATION_ENABLED &&
    process.env.INTEGRATION_ENABLED === "true"
  ) {
    logger.info(
      "Bot installed as an integration, obtaining installation token"
    );
    return await installationToken(webhook.installation.id);
  } else {
    logger.info("Bot installed as a webhook, using access token");
    return process.env.GITHUB_ACCESS_TOKEN;
  }
};

const response = (body, statusCode = 200) => ({
  statusCode,
  body: JSON.stringify(body)
});

const applyToken = token => {
  const api = {};
  const { githubRequest, isAllowedUrl, ...endpoints } = githubApi;
  Object.keys(endpoints).forEach(apiMethod => {
    api[apiMethod] = (...args) =>
      githubRequest(endpoints[apiMethod].apply(null, args), token);
  });
  return api;
};

const requestBody = ({ body, isBase64Encoded }) =>
  isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;

// GitHub signs each webhook delivery using the app's webhook secret, see:
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const validSignature = (body, headers = {}) => {
  if (!process.env.WEBHOOK_SECRET) {
    // fail closed when a secret is required but has not been configured
    return process.env.REQUIRE_SIGNATURE !== "true";
  }
  // function URLs lower-case header names, API Gateway preserves their case
  const header = Object.keys(headers || {}).find(
    h => h.toLowerCase() === "x-hub-signature-256"
  );
  const signature = Buffer.from((header && headers[header]) || "");
  const expected = Buffer.from(
    "sha256=" +
      crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(body)
        .digest("hex")
  );
  return (
    signature.length === expected.length &&
    crypto.timingSafeEqual(signature, expected)
  );
};

// the lambda interface is a bit clumsy, this adapts it into something more manageable
const constructHandler = fn => async event => {
  logger.reset();

  const body = requestBody(event);
  if (!validSignature(body, event.headers)) {
    logger.error("webhook signature verification failed");
    return response({ error: "invalid signature" }, 401);
  }

  try {
    const res = await fn(JSON.parse(body));

    if (typeof res === "string") {
      logger.debug("integration webhook callback response", res);
      return response({ message: res });
    }
    logger.error(`unexpected lambda function return value ${res}`);
    return response({ error: "unexpected return value" }, 500);
  } catch (err) {
    logger.error(err.toString());
    return response({ error: err.toString() }, 500);
  } finally {
    try {
      await logger.flush();
    } catch (err) {
      console.error(`failed to write log to S3: ${err}`);
    }
  }
};

exports.handler = constructHandler(async webhook => {
  if (!validAction(webhook)) {
    return `ignored action of type ${webhook.action}`;
  }

  const { pullRequest: pullRequestUrl, issue: issueUrl } = gitHubUrls(webhook);

  // determine the URL for storing the event log
  const org = pullRequestUrl.split("/")[4];
  const logUrl = `${org}-${uuid()}`;
  const logFile = `https://s3.amazonaws.com/${
    process.env.LOGGING_BUCKET
  }/${logUrl}`;

  if (webhook.action === "created") {
    if (!commentSummonsBot(webhook.comment.body)) {
      return "the comment didnt summon the cla-bot";
    } else if (webhook.comment.user.login === `${process.env.BOT_NAME}[bot]`) {
      return "the cla-bot summoned itself. Ignored!";
    }
  }

  // from this point on a CLA check is performed, so the log is written to S3
  logger.logFile(logUrl);
  if (webhook.action === "created") {
    logger.info("The cla-bot has been summoned by a comment");
  }

  logger.info(`Checking CLAs for pull request ${pullRequestUrl}`);

  // obtain the token and apply it to all of our API methods
  const token = await obtainToken(webhook);
  const {
    getLabels,
    getOrgConfig,
    getReadmeUrl,
    getFile,
    addLabel,
    getCommits,
    getMergeGroupCommits,
    setStatus,
    addCommentNoCLA,
    addCommentUnidentified,
    deleteLabel,
    addRecheckComment
  } = applyToken(token);

  logger.info("Obtaining the list of commits for the pull request");
  let commits;
  if (mergeGroupAction(webhook)) {
    const commitResponse = await getMergeGroupCommits(webhook);
    commits = commitResponse.commits || [];
    const commitsWithoutMergeGroupHead = commits.filter(
      c => c.sha !== webhook.merge_group.head_sha
    );
    commits =
      commitsWithoutMergeGroupHead.length > 0
        ? commitsWithoutMergeGroupHead
        : commits;
  } else {
    commits = await getCommits(pullRequestUrl);
  }

  logger.info(
    `Total Commits: ${commits.length}, checking CLA status for committers`
  );

  // PRs include the head sha, for comments we have to determine this from the commit history
  let headSha;
  if (mergeGroupAction(webhook)) {
    headSha = webhook.merge_group.head_sha;
  } else if (webhook.pull_request) {
    headSha = webhook.pull_request.head.sha;
  } else {
    headSha = commits[commits.length - 1].sha;
  }

  const unresolvedLoginNames = sortUnique(
    commits.filter(c => c.author == null).map(c => c.commit.author.name)
  );

  let orgConfig;
  try {
    logger.info("Attempting to obtain organisation level .clabot file URL");
    orgConfig = await getOrgConfig(webhook);
    logger.info("Organisation configuration found!");
  } catch (e) {
    logger.info(
      "Organisation configuration not found, resolving .clabot URL at project level"
    );
    orgConfig = await getReadmeUrl(webhook);
  }

  logger.info(
    `Obtaining .clabot configuration file from ${
      orgConfig.download_url.split("?")[0]
    }`
  );

  const config = await getFile(orgConfig);

  if (!is.json(config)) {
    logger.error("The .clabot file is not valid JSON");
    await setStatus(webhook, headSha, "error", logFile);
    throw new Error("The .clabot file is not valid JSON");
  }

  // merge with default config options
  const botConfig = Object.assign({}, defaultConfig, config);

  const removeLabelAndSetFailureStatus = async users => {
    await deleteLabel(issueUrl, botConfig.label);
    await setStatus(webhook, headSha, "error", logFile);
    return `CLA has not been signed by users ${users}, added a comment to ${pullRequestUrl}`;
  };

  let message;
  if (unresolvedLoginNames.length > 0) {
    const unidentifiedString = unresolvedLoginNames.join(", ");
    logger.info(
      `Some commits from the following contributors are not signed with a valid email address: ${unidentifiedString}. `
    );
    if (mergeGroupAction(webhook)) {
      await setStatus(webhook, headSha, "error", logFile);
      return `CLA has not been signed by users ${unidentifiedString}, set failure status on merge group ${pullRequestUrl}`;
    }
    await addCommentUnidentified(
      issueUrl,
      botConfig.messageMissingEmail,
      unidentifiedString
    );
    message = await removeLabelAndSetFailureStatus(unidentifiedString);
  } else {
    // the GitHub commit contains git author information (within commit.author), and GitHub author
    // information (with author), we need both depending on verification more, so combine.
    // see: https://developer.github.com/v3/pulls/#list-commits-on-a-pull-request
    const committers = commits.map(c => ({
      ...(c.commit ? c.commit.author : {}),
      ...c.author
    }));
    const verifier = contributionVerifier(botConfig);
    const nonContributors = await verifier(committers, token);

    if (mergeGroupAction(webhook)) {
      if (nonContributors.length === 0) {
        await setStatus(webhook, headSha, "success", logFile);
        return `set success status on merge group ${pullRequestUrl}`;
      }

      const usersWithoutCLA = sortUnique(nonContributors)
        .map(contributorId => `@${contributorId}`)
        .join(", ");
      await setStatus(webhook, headSha, "error", logFile);
      return `CLA has not been signed by users ${usersWithoutCLA}, set failure status on merge group ${pullRequestUrl}`;
    }

    if (nonContributors.length === 0) {
      logger.info(
        "All contributors have a signed CLA, adding success status to the pull request and a label"
      );

      const labels = await getLabels(issueUrl);

      // check whether this label already exists
      if (!labels.some(l => l.name === botConfig.label)) {
        await addLabel(issueUrl, botConfig.label);
      } else {
        logger.info(
          `The pull request already has the label ${botConfig.label}`
        );
      }

      await setStatus(webhook, headSha, "success", logFile);

      message = `added label ${botConfig.label} to ${pullRequestUrl}`;
    } else {
      const usersWithoutCLA = sortUnique(nonContributors)
        .map(contributorId => `@${contributorId}`)
        .join(", ");
      logger.info(
        `The contributors ${usersWithoutCLA} have not signed the CLA, adding error status to the pull request`
      );
      await addCommentNoCLA(issueUrl, botConfig.message, usersWithoutCLA);

      message = await removeLabelAndSetFailureStatus(usersWithoutCLA);
    }
  }

  if (webhook.action === "created") {
    await addRecheckComment(issueUrl, botConfig.recheckComment);
  }

  return message;
});

exports.test = {
  commentSummonsBot
};
