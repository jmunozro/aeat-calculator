const ONE_DAY = 24 * 60 * 60 * 1000;
const DO_NOT_DELETE_KEY_NEWER_THAN_MILLIS = parseInt(process.env.KEY_MAX_AGE_MILLIS, 10) || 6 * ONE_DAY;
const KEY_MAX_AGE_MILLIS = parseInt(process.env.KEY_MAX_AGE_MILLIS, 10) || 45 * ONE_DAY;
const USERNAME = process.env.USERNAME || "";
const SECRETMANAGER_NAME = process.env.SECRETMANAGER_NAME || ""
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || ""
const AWS_ACCOUNT_NAME = process.env.AWS_ACCOUNT_NAME || ""

module.exports = {
  KEY_MAX_AGE_MILLIS,
  DO_NOT_DELETE_KEY_NEWER_THAN_MILLIS,
  SECRETMANAGER_NAME,
  USERNAME,
  AWS_ACCOUNT_ID,
  AWS_ACCOUNT_NAME,
};