module.exports = {
  config: {
    name: "bby",
    version: "1.0.0",
    author: "skromjan2590cs",
    countDown: 3,
    role: 0,
    shortDescription: "Sweet GF style replies",
    category: "fun"
  },

  onStart: async function ({ api, event, args }) {
    const replies = [
      "Jaan, boloo kemon acho? ❤️",
      "Hmm jann bby kmn acho?🙂",
      "হুম জান তুমার জন্য অপেক্ষা করতে ছিলাম কই ছিলা এতো ক্ষণ",
      "Ummah! Amar bby ta ki korche? 🙈",
      "Kotha bolba na amar sathe? Khub miss korchilam! 🥺",
      "Ji babu, bolo ki bolba? Amar sob somoy tomar jonno somoy ache! 💕",
      "Khawa dawa korcho thik moto? Khub dushtami korcho kintu! 💖",
      "Babu ta amar! Aijke sara din koi chila? 🥺"
    ];

    // Pick a random message from the list
    const randomReply = replies[Math.floor(Math.random() * replies.length)];

    return api.sendMessage(randomReply, event.threadID, event.messageID);
  }
};
