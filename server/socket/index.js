const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

const app = express();

/*** Socket connection */
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL, // Ensure your frontend URL is correct
    credentials: true,
  },
});

/*** Online users */
const onlineUser = new Set();

io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);

  const token = socket.handshake.auth.token; // Getting token from the client

  if (!token) {
    console.log('No token provided');
    return;
  }

  // Get user details from token
  const user = await getUserDetailsFromToken(token);

  if (!user || !user._id) {
    console.log('Invalid or missing user details');
    return;
  }

  // Join user to their own room
  socket.join(user._id.toString());
  onlineUser.add(user._id.toString());
  io.emit('onlineUser', Array.from(onlineUser)); // Emit online users

  socket.on('message-page', async (userId) => {
    console.log('UserId for message-page:', userId);

    const userDetails = await UserModel.findById(userId).select('-password');

    const payload = {
      _id: userDetails?._id,
      name: userDetails?.name,
      email: userDetails?.email,
      profile_pic: userDetails?.profile_pic,
      online: onlineUser.has(userId),
    };

    socket.emit('message-user', payload);

    // Get previous conversation messages
    const getConversationMessage = await ConversationModel.findOne({
      $or: [
        { sender: user._id, receiver: userId },
        { sender: userId, receiver: user._id },
      ],
    }).populate('messages')
      .sort({ updatedAt: -1 });

    socket.emit('message', getConversationMessage?.messages || []);
  });

  // New message event
  socket.on('new message', async (data) => {
    let conversation = await ConversationModel.findOne({
      $or: [
        { sender: data?.sender, receiver: data?.receiver },
        { sender: data?.receiver, receiver: data?.sender },
      ],
    });

    if (!conversation) {
      const createConversation = await new ConversationModel({
        sender: data?.sender,
        receiver: data?.receiver,
      });
      conversation = await createConversation.save();
    }

    const message = new MessageModel({
      text: data.text,
      imageUrl: data.imageUrl,
      videoUrl: data.videoUrl,
      msgByUserId: data?.msgByUserId,
    });

    const saveMessage = await message.save();

    const updateConversation = await ConversationModel.updateOne(
      { _id: conversation?._id },
      {
        $push: { messages: saveMessage?._id },
      }
    );

    const getConversationMessage = await ConversationModel.findOne({
      $or: [
        { sender: data?.sender, receiver: data?.receiver },
        { sender: data?.receiver, receiver: data?.sender },
      ],
    }).populate('messages').sort({ updatedAt: -1 });

    io.to(data?.sender).emit('message', getConversationMessage?.messages || []);
    io.to(data?.receiver).emit('message', getConversationMessage?.messages || []);

    // Send updated conversation
    const conversationSender = await getConversation(data?.sender);
    const conversationReceiver = await getConversation(data?.receiver);

    io.to(data?.sender).emit('conversation', conversationSender);
    io.to(data?.receiver).emit('conversation', conversationReceiver);
  });

  // Sidebar
  socket.on('sidebar', async (currentUserId) => {
    console.log('Current user for sidebar:', currentUserId);

    const conversation = await getConversation(currentUserId);
    socket.emit('conversation', conversation);
  });

  // Mark messages as seen
  socket.on('seen', async (msgByUserId) => {
    let conversation = await ConversationModel.findOne({
      $or: [
        { sender: user._id, receiver: msgByUserId },
        { sender: msgByUserId, receiver: user._id },
      ],
    });

    const conversationMessageId = conversation?.messages || [];

    const updateMessages = await MessageModel.updateMany(
      { _id: { $in: conversationMessageId }, msgByUserId: msgByUserId },
      { $set: { seen: true } }
    );

    // Send updated conversation
    const conversationSender = await getConversation(user._id.toString());
    const conversationReceiver = await getConversation(msgByUserId);

    io.to(user._id.toString()).emit('conversation', conversationSender);
    io.to(msgByUserId).emit('conversation', conversationReceiver);
  });

  // Disconnect
  socket.on('disconnect', () => {
    onlineUser.delete(user._id.toString());
    console.log('User disconnected:', socket.id);
    io.emit('onlineUser', Array.from(onlineUser));
  });
});

module.exports = {
  app,
  server,
};
