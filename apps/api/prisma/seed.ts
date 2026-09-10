import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "demo@inkdesk.in";
  const passwordHash = await bcrypt.hash("demo1234", 10);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already exists:", email, "/ demo1234");
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: "Demo Owner",
      passwordHash,
      phone: "9876543210",
    },
  });

  const merchant = await prisma.merchant.create({
    data: { name: "Demo Xerox Merchant", ownerId: user.id },
  });

  const shop = await prisma.shop.create({
    data: {
      merchantId: merchant.id,
      name: "Campus Xerox Point",
      slug: "campus-xerox",
      city: "Delhi",
      address: "Near Gate 2, University Road",
      phone: "9876543210",
      autoPrint: false,
      requireApproval: true,
    },
  });

  await prisma.shopStaff.create({
    data: { shopId: shop.id, userId: user.id, role: "OWNER" },
  });

  await prisma.pricingRule.createMany({
    data: [
      { shopId: shop.id, name: "A4 B&W", paperSize: "A4", colorMode: "BW", duplex: false, pricePerPage: 2 },
      { shopId: shop.id, name: "A4 B&W Duplex", paperSize: "A4", colorMode: "BW", duplex: true, pricePerPage: 3 },
      { shopId: shop.id, name: "A4 Colour", paperSize: "A4", colorMode: "COLOR", duplex: false, pricePerPage: 8 },
      { shopId: shop.id, name: "A4 Colour Duplex", paperSize: "A4", colorMode: "COLOR", duplex: true, pricePerPage: 12 },
      { shopId: shop.id, name: "A3 B&W", paperSize: "A3", colorMode: "BW", duplex: false, pricePerPage: 5 },
      { shopId: shop.id, name: "A3 Colour", paperSize: "A3", colorMode: "COLOR", duplex: false, pricePerPage: 15 },
    ],
  });

  console.log("Seeded demo shop:");
  console.log("  Merchant login: demo@inkdesk.in / demo1234");
  console.log("  Customer URL:   http://localhost:3000/s/campus-xerox");
  console.log("  Printers: none seeded — connect a real PrintMyDoc Agent from the dashboard's Printers tab.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
