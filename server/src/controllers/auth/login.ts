import bcrypt from "bcrypt";
import JWT from "jsonwebtoken";

import { User } from "../../models/user.model";
import { ORMContext, redisClient } from "../../server";
import { FilterFrontendKeys } from "../../utils/FrontendKey";
import { KoaController } from "../../utils/KoaController";
import {
  emailPasswordErr,
  discordVerifyErr,
  tokenAuthFailureErr,
  userPermaBannedErr,
} from "../../errors/errors";
import { logging } from "../../utils/logger";
import { BymJwtPayload, verifyJwtToken } from "../../middleware/auth";
import { Status } from "../../enums/StatusCodes";
import { Context } from "koa";
import { UserLoginSchema } from "./zod/AuthSchemas";
import { Env } from "../../enums/Env";

/**
 * Authenticates a user using a JWT token.
 *
 * This function verifies the provided JWT token and retrieves the associated user record
 * from the database. If the token is valid and the user exists, it returns the user record.
 * If the token is invalid or the user does not exist, it throws an authentication failure error.
 *
 * @param {Context} ctx - The Koa context object.
 * @returns {Promise<User>} - A promise that resolves to the authenticated user record.
 * @throws {Error} - Throws an error if the token is invalid or the user does not exist.
 */
const authenticateWithToken = async (ctx: Context) => {
  const { token } = UserLoginSchema.parse(ctx.request.body);
  const { user } = verifyJwtToken(token);

  const storedToken = await redisClient.get(`user-token:${user.email}`);
  if (storedToken !== token) throw tokenAuthFailureErr();

  let userRecord = await ORMContext.em.findOne(User, { email: user.email });
  if (!userRecord) throw emailPasswordErr();

  return userRecord;
};

/**
 * Controller to handle user login.
 *
 * This controller authenticates a user based on the provided email & password.
 * If the authentication is successful, it generates a JWT token and returns the
 * user information along with the token. If authentication fails, it throws an
 * authentication failure error.
 *
 * @param {Context} ctx - The Koa context object.
 * @returns {Promise<void>} - A promise that resolves when the controller is complete.
 * @throws {Error} - Throws an error if authentication fails or if the request body is invalid.
 */
export const login: KoaController = async (ctx) => {
  let { email, password, token } = UserLoginSchema.parse(ctx.request.body);

  let user: User | null = null;
  let isVerified = false;

  if (token) {
    try {
      user = await authenticateWithToken(ctx);
    } catch (err) {}
  }

  if (!user) {
    user = await ORMContext.em.findOne(User, { email });
    if (!user) throw emailPasswordErr();

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw emailPasswordErr();
  }

  if (user.banned) throw userPermaBannedErr();

  // Generate and set the token
  const sessionLifeTime = process.env.SESSION_LIFETIME || "30d";
  let discordId: string;

  // TODO: This is a temporary hack to get the discord user verification. This should be refactored.
  if (process.env.ENV === Env.PROD) {
    const connection = ORMContext.em.getConnection();

    const result = await connection.execute(
      "SELECT * from bym_discord.users WHERE email = ?",
      [user.email]
    );

    isVerified = result.length > 0;
    if (!isVerified) throw discordVerifyErr();

    discordId = result[0].discord_id;
  }

  const isOlderThanOneWeek = (snowflakeId: string) => {
    // Discord's epoch starts at 2015-01-01T00:00:00 UTC
    const discordEpoch = 1420070400000;

    // Extract the timestamp from the Snowflake ID (first 42 bits)
    const timestamp = Number(BigInt(snowflakeId) >> 22n) + discordEpoch;

    const creationDate = new Date(timestamp);
    const oneWeekAgo = new Date();

    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    return creationDate < oneWeekAgo;
  };

  const newToken = JWT.sign(
    {
      user: {
        email: user.email,
        discordId,
        meetsDiscordAgeCheck:
          process.env.ENV !== Env.PROD || isOlderThanOneWeek(discordId),
      },
    } satisfies BymJwtPayload,
    process.env.SECRET_KEY,
    {
      expiresIn: sessionLifeTime,
    }
  );

  await redisClient.set(`user-token:${user.email}`, newToken);
  await ORMContext.em.persistAndFlush(user);

  const filteredUser = FilterFrontendKeys(user);
  logging(
    `User ${filteredUser.username} successful login | ID: ${filteredUser.userid} | Email: ${filteredUser.email} | IP Address: ${ctx.ip}`
  );

  const userToken = await redisClient.get(`user-token:${user.email}`);

  ctx.status = Status.OK;
  ctx.body = {
    error: 0,
    userId: filteredUser.userid,
    ...filteredUser,
    version: 128,
    token: userToken,
    mapversion: 2,
    mailversion: 1,
    soundversion: 1,
    languageversion: 8,
    app_id: "",
    tpid: "",
    currency_url: "",
    language: "en",
    settings: {},
  };
};
