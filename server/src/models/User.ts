import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Optional: users who sign up with Google/GitHub have no password.
    passwordHash: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true },
    githubId: { type: String, unique: true, sparse: true },
    avatarUrl: { type: String },
    /** Proven by clicking the emailed link, signing in with Google/GitHub, or resetting the password. */
    emailVerified: { type: Boolean, default: false },
    verifyTokenHash: { type: String, select: false, index: { sparse: true } },
    verifyTokenExpires: { type: Date, select: false },
    /** Bumped on password change / "sign out everywhere" – invalidates all existing sessions. */
    tokenVersion: { type: Number, default: 0 },
    // My default AI behaviour (overrides of the system profile; see services/aiBehaviour.ts).
    aiBehaviour: { type: Schema.Types.Mixed },
    // What the follow-through agent may do after my meetings (services/followThrough.ts).
    followThrough: { type: Schema.Types.Mixed },
    /** SHA-256 of the one-time password-reset token, never the token itself. */
    resetTokenHash: { type: String, select: false, index: { sparse: true } },
    resetTokenExpires: { type: Date, select: false },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof UserSchema>;
export type UserDoc = HydratedDocument<User>;

export const UserModel = model('User', UserSchema);

export function toPublicUser(user: UserDoc) {
  return {
    id: user.id as string,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    hasPassword: !!user.passwordHash,
    emailVerified: !!user.emailVerified,
    providers: { google: !!user.googleId, github: !!user.githubId },
  };
}
