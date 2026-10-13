import mongoose from 'mongoose';
import { User, Workspace, Membership, Session } from '../models/index.js';

export const mongoStore = {
  findUserByEmail: email => User.findOne({ email }).select('+passwordHash'),
  findUser: id => User.findById(id),
  createUser: data => User.create(data),
  createSession: data => Session.create(data),
  findSession: tokenHash => Session.findOne({ tokenHash, expiresAt: { $gt: new Date() } }),
  deleteSession: tokenHash => Session.deleteOne({ tokenHash }),
  membership: (workspaceId, userId) => Membership.findOne({ workspaceId, userId }),
  workspace: id => Workspace.findById(id),
  listWorkspaces: async userId => {
    const memberships = await Membership.find({ userId }).populate('workspaceId');
    return memberships.filter(item => item.workspaceId).map(item => ({ workspace: item.workspaceId, role: item.role }));
  },
  createWorkspace: async (data, userId) => {
    return mongoose.connection.transaction(async session => {
      const [workspace] = await Workspace.create([{ ...data, createdBy: userId }], { session });
      await Membership.create([{ workspaceId: workspace._id, userId, role: 'owner' }], { session });
      return workspace;
    });
  },
  addMember: data => Membership.create(data)
};
