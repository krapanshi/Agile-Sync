import mongoose from 'mongoose';

const { Schema } = mongoose;
const options = { timestamps: true, strict: 'throw', optimisticConcurrency: true };
const reference = (ref, required = true) => ({ type: Schema.Types.ObjectId, ref, required });
const text = (maxlength) => ({ type: String, trim: true, required: true, maxlength });
const position = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };

const userSchema = new Schema({
  name: text(100),
  email: { ...text(254), lowercase: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  passwordHash: { type: String, required: true, select: false }
}, options);
userSchema.index({ email: 1 }, { unique: true });
userSchema.set('toJSON', { transform: (_doc, result) => { delete result.passwordHash; return result; } });

const workspaceSchema = new Schema({
  name: text(100),
  slug: { ...text(80), lowercase: true, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  createdBy: reference('User')
}, options);
workspaceSchema.index({ slug: 1 }, { unique: true });

const membershipSchema = new Schema({
  workspaceId: reference('Workspace'),
  userId: reference('User'),
  role: { type: String, required: true, enum: ['owner', 'admin', 'member', 'viewer'] }
}, options);
membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, workspaceId: 1 });

const columnSchema = new Schema({ name: text(100), position }, { strict: 'throw' });
const boardSchema = new Schema({
  workspaceId: reference('Workspace'),
  name: text(120),
  createdBy: reference('User'),
  columns: {
    type: [columnSchema],
    default: () => [
      { name: 'To Do', position: 0 },
      { name: 'In Progress', position: 1000 },
      { name: 'Done', position: 2000 }
    ],
    validate: {
      validator: (columns) => columns.length >= 1 && columns.length <= 30
        && new Set(columns.map(column => String(column._id))).size === columns.length
        && new Set(columns.map(column => column.position)).size === columns.length,
      message: 'Boards require 1–30 columns with distinct IDs and positions'
    }
  }
}, options);
boardSchema.index({ workspaceId: 1, updatedAt: -1, _id: 1 });

const taskSchema = new Schema({
  workspaceId: reference('Workspace'),
  boardId: reference('Board'),
  columnId: { type: Schema.Types.ObjectId, required: true },
  title: text(200),
  description: { type: String, default: '', maxlength: 10000 },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  assigneeId: reference('User', false),
  createdBy: reference('User'),
  position,
  dueAt: { type: Date, default: null }
}, options);
taskSchema.index({ workspaceId: 1, boardId: 1, columnId: 1, position: 1, _id: 1 });
taskSchema.index({ workspaceId: 1, assigneeId: 1, updatedAt: -1 });

export const User = mongoose.model('User', userSchema);
export const Workspace = mongoose.model('Workspace', workspaceSchema);
export const Membership = mongoose.model('Membership', membershipSchema);
export const Board = mongoose.model('Board', boardSchema);
export const Task = mongoose.model('Task', taskSchema);
const sessionSchema = new Schema({
  userId: reference('User'),
  tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false },
  expiresAt: { type: Date, required: true }
}, options);
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });
export const Session = mongoose.model('Session', sessionSchema);
export const models = [User, Workspace, Membership, Board, Task, Session];

