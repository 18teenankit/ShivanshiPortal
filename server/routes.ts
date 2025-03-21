import express, { type Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { loginSchema, insertContactRequestSchema, insertCategorySchema, insertProductSchema, insertProductImageSchema, insertHeroImageSchema, insertSettingSchema } from "@shared/schema";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import MemoryStore from "memorystore";
import multer from "multer";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// Session store
const MemoryStoreSession = MemoryStore(session);
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 15 * 60 * 1000; // 15 minutes

// Login attempts tracking
const loginAttempts = new Map<string, { count: number, lockUntil?: number }>();

// Configure multer for file uploads
const storage_config = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(process.cwd(), "uploads");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage_config });

export async function registerRoutes(app: Express): Promise<Server> {
  // Serve static files from uploads directory
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
  
  // Simple health check endpoint
  app.get("/api/health", (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
  
  // Configure session middleware
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "shivanshi-enterprises-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { 
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        secure: false,
        httpOnly: true,
        path: '/',
        sameSite: 'lax'
      },
      store: new MemoryStoreSession({
        checkPeriod: 86400000, // 1 day
      }),
    })
  );

  // Configure Passport with local strategy
  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        // Check if user is locked out
        const attempts = loginAttempts.get(username) || { count: 0 };
        if (attempts.lockUntil && attempts.lockUntil > Date.now()) {
          return done(null, false, { message: "Account is locked. Try again later." });
        }

        const user = await storage.validateUser(username, password);

        if (!user) {
          // Increment failed login attempts
          loginAttempts.set(username, {
            count: attempts.count + 1,
            lockUntil: attempts.count + 1 >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCK_TIME : undefined
          });

          return done(null, false, { message: "Invalid username or password" });
        }

        // Reset login attempts on successful login
        loginAttempts.delete(username);

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    })
  );

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());

  // Middleware to ensure a user is authenticated
  const isAuthenticated = (req: Request, res: Response, next: Function) => {
    if (req.isAuthenticated()) {
      return next();
    }
    res.status(401).json({ message: "Unauthorized" });
  };

  // Middleware to ensure a user has super_admin role
  const isSuperAdmin = (req: Request, res: Response, next: Function) => {
    if (req.isAuthenticated() && (req.user as any).role === 'super_admin') {
      // Protect Ankit's account
      if ((req.params.id === '2' || req.body.username === 'ankit') && (req.user as any).username !== 'ankit') {
        return res.status(403).json({ message: "Cannot modify super admin account" });
      }
      return next();
    }
    res.status(403).json({ message: "Forbidden - requires super admin privileges" });
  };

  // Error handler for Zod validation errors
  const handleZodError = (error: unknown, res: Response) => {
    if (error instanceof ZodError) {
      const validationError = fromZodError(error);
      return res.status(400).json({ message: validationError.message });
    }
    return res.status(500).json({ message: "Server error" });
  };

  // Public API endpoints
  app.get("/api/categories", async (req, res) => {
    try {
      const categories = await storage.getCategories();
      res.json(categories);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch categories" });
    }
  });

  app.get("/api/categories/:id", async (req, res) => {
    try {
      const category = await storage.getCategory(Number(req.params.id));
      if (!category) {
        return res.status(404).json({ message: "Category not found" });
      }
      res.json(category);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch category" });
    }
  });

  app.get("/api/products", async (req, res) => {
    try {
      // Set JSON content type header
      res.setHeader('Content-Type', 'application/json');
      // Prevent caching
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;

      let products;
      try {
        if (categoryId) {
          products = await storage.getProductsByCategory(categoryId);
        } else {
          products = await storage.getProducts();
        }
      } catch (error) {
        console.error("Error fetching products:", error);
        return res.status(500).json({ message: "Failed to fetch products from storage" });
      }

      // Enhance products with category info only - no images
      try {
        const enhancedProducts = await Promise.all(
          products.map(async (product) => {
            const category = product.categoryId 
              ? await storage.getCategory(product.categoryId) 
              : undefined;

            return {
              ...product,
              category: category ? { id: category.id, name: category.name } : null,
              mainImage: null // Always set to null to maintain API structure but remove image functionality
            };
          })
        );

        res.json(enhancedProducts);
      } catch (error) {
        console.error("Error enhancing products:", error);
        return res.status(500).json({ message: "Failed to process products" });
      }
    } catch (error) {
      console.error("Global products error:", error);
      res.status(500).json({ message: "Failed to fetch products" });
    }
  });

  app.get("/api/products/:id", async (req, res) => {
    try {
      const product = await storage.getProduct(Number(req.params.id));
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      const category = product.categoryId 
        ? await storage.getCategory(product.categoryId) 
        : undefined;

      // No images needed for the simplified version
      res.json({
        ...product,
        category: category ? { id: category.id, name: category.name } : null,
        images: [] // Always return an empty array to maintain API structure without images
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch product" });
    }
  });

  app.get("/api/hero-images", async (req, res) => {
    try {
      // Set JSON content type header
      res.setHeader('Content-Type', 'application/json');
      // Prevent caching
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      console.log("Hero images request received");
      
      try {
        const heroImages = await storage.getHeroImages();
        console.log(`Retrieved ${heroImages.length} hero images`);
        return res.json(heroImages);
      } catch (error) {
        console.error("Error fetching hero images from storage:", error);
        return res.status(500).json({ message: "Failed to fetch hero images from storage" });
      }
    } catch (error) {
      console.error("Global hero images error:", error);
      res.status(500).json({ message: "Failed to fetch hero images" });
    }
  });

  app.post("/api/contact", async (req, res) => {
    try {
      const contactData = insertContactRequestSchema.parse(req.body);
      const result = await storage.createContactRequest(contactData);

      // Here you would typically add code to send email notification
      // But we'll skip that for now since we don't have access to an email service

      res.status(201).json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.get("/api/settings", async (req, res) => {
    try {
      const settings = await storage.getAllSettings();
      // Convert array to key-value object with proper type handling
      const settingsObj = settings.reduce((acc, setting) => {
        if (setting.key && setting.value !== null) {
          acc[setting.key] = setting.value;
        }
        return acc;
      }, {} as Record<string, string | undefined>);

      // Prevent caching of settings
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.json(settingsObj);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  // Auth endpoints
  app.post("/api/login", (req, res, next) => {
    // Always ensure proper content type for auth endpoints
    res.setHeader('Content-Type', 'application/json');
    
    try {
      // Parse login data
      const loginData = loginSchema.parse(req.body);
      console.log("Login attempt received");

      // Check if user is already authenticated
      if (req.isAuthenticated()) {
        if (req.user) {
          const user = req.user as any;
          const safeUser = {
            id: user.id,
            username: user.username,
            role: user.role
          };
          return res.json({ user: safeUser });
        }
      }

      // Check if user is locked out
      const attempts = loginAttempts.get(loginData.username) || { count: 0 };
      if (attempts.lockUntil && attempts.lockUntil > Date.now()) {
        const remainingTime = Math.ceil((attempts.lockUntil - Date.now()) / 60000);
        return res.status(429).json({ 
          message: `Account is locked. Try again in ${remainingTime} minutes.` 
        });
      }

      // Use passport for authentication
      passport.authenticate("local", (authError: Error | null, user: any, info: { message: string }) => {
        if (authError) {
          console.error("Authentication error:", authError);
          return res.status(500).json({ message: "Authentication error occurred" });
        }
        
        if (!user) {
          return res.status(401).json({ message: info?.message || "Invalid credentials" });
        }

        req.logIn(user, (loginError) => {
          if (loginError) {
            console.error("Login error:", loginError);
            return res.status(500).json({ message: "Login error occurred" });
          }

          // Set session cookie to expire in 30 days
          if (req.session) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
          }

          // Reset login attempts
          if (loginAttempts.has(loginData.username)) {
            loginAttempts.delete(loginData.username);
          }

          // Remove sensitive info
          const safeUser = {
            id: user.id,
            username: user.username,
            role: user.role
          };
          
          return res.json({ user: safeUser });
        });
      })(req, res, next);
    } catch (error) {
      console.error("Login validation error:", error);
      handleZodError(error, res);
    }
  });
  
  // Logout endpoint
  app.post("/api/logout", (req, res) => {
    if (req.isAuthenticated()) {
      req.logout((err) => {
        if (err) {
          return res.status(500).json({ message: "Failed to logout" });
        }
        
        // Destroy the session
        if (req.session) {
          req.session.destroy((err) => {
            if (err) {
              return res.status(500).json({ message: "Failed to destroy session" });
            }
            
            // Clear the cookie
            res.clearCookie("connect.sid", {
              path: "/",
              httpOnly: true,
              sameSite: 'lax'
            });
            
            return res.json({ message: "Logged out successfully" });
          });
        } else {
          // Clear the cookie
          res.clearCookie("connect.sid", {
            path: "/",
            httpOnly: true,
            sameSite: 'lax'
          });
          
          return res.json({ message: "Logged out successfully" });
        }
      });
    } else {
      return res.json({ message: "Not logged in" });
    }
  });

  app.get("/api/current-user", (req, res) => {
    // Set JSON content type header
    res.setHeader('Content-Type', 'application/json');
    // Prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Remove sensitive info
    const user = req.user as any;
    const safeUser = {
      id: user.id,
      username: user.username,
      role: user.role
    };
    
    res.json({ user: safeUser });
  });

  // Admin API endpoints (protected)
  // Categories management
  app.post("/api/admin/categories", isAuthenticated, upload.single("image"), async (req, res) => {
    try {
      const imageUrl = req.file ? `/uploads/${req.file.filename}` : undefined;

      const categoryData = insertCategorySchema.parse({
        ...req.body,
        image: imageUrl || req.body.image
      });

      const result = await storage.createCategory(categoryData);
      res.status(201).json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.put("/api/admin/categories/:id", isAuthenticated, upload.single("image"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const imageUrl = req.file ? `/uploads/${req.file.filename}` : undefined;

      // Only include the image in the update if a new one was uploaded
      const updateData = { ...req.body };
      if (imageUrl) {
        updateData.image = imageUrl;
      }

      const result = await storage.updateCategory(id, updateData);
      if (!result) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.delete("/api/admin/categories/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteCategory(id);

      if (!success) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json({ message: "Category deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete category" });
    }
  });

  // Products management
  app.post("/api/admin/products", isAuthenticated, async (req, res) => {
    try {
      // Convert numeric string values to numbers
      const productData = {
        ...req.body,
        categoryId: req.body.categoryId ? Number(req.body.categoryId) : undefined
      };
      
      const parsedData = insertProductSchema.parse(productData);
      const result = await storage.createProduct(parsedData);
      res.status(201).json(result);
    } catch (error) {
      console.error("Product creation error:", error);
      handleZodError(error, res);
    }
  });

  app.put("/api/admin/products/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      
      // Convert numeric string values to numbers
      const productData = {
        ...req.body,
        categoryId: req.body.categoryId ? Number(req.body.categoryId) : undefined
      };
      
      const result = await storage.updateProduct(id, productData);

      if (!result) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json(result);
    } catch (error) {
      console.error("Product update error:", error);
      handleZodError(error, res);
    }
  });

  app.delete("/api/admin/products/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteProduct(id);

      if (!success) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json({ message: "Product deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete product" });
    }
  });

  // Product Images
  app.post("/api/admin/product-images", isAuthenticated, upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Image file is required" });
      }

      const imageUrl = `/uploads/${req.file.filename}`;

      const imageData = insertProductImageSchema.parse({
        ...req.body,
        productId: Number(req.body.productId),
        imageUrl: imageUrl,
        isMain: req.body.isMain === "true",
        order: Number(req.body.order || 0)
      });

      // If this is the main image, update other images for this product
      if (imageData.isMain) {
        const existingImages = await storage.getProductImages(imageData.productId);
        for (const image of existingImages) {
          if (image.isMain) {
            await storage.updateProductImage(image.id, { isMain: false });
          }
        }
      }

      const result = await storage.createProductImage(imageData);
      res.status(201).json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.delete("/api/admin/product-images/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteProductImage(id);

      if (!success) {
        return res.status(404).json({ message: "Image not found" });
      }

      res.json({ message: "Product image deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete product image" });
    }
  });

  // Hero Images
  app.get("/api/admin/hero-images", isAuthenticated, async (req, res) => {
    try {
      // For admin, get all hero images including inactive ones
      const heroImages = Array.from((await storage as any).heroImages.values())
        .sort((a: any, b: any) => a.order - b.order);

      res.json(heroImages);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch hero images" });
    }
  });

  app.post("/api/admin/hero-images", isAuthenticated, upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Image file is required" });
      }

      const imageUrl = `/uploads/${req.file.filename}`;

      const imageData = insertHeroImageSchema.parse({
        ...req.body,
        imageUrl: imageUrl,
        order: Number(req.body.order || 0),
        isActive: req.body.isActive === "true"
      });

      const result = await storage.createHeroImage(imageData);
      res.status(201).json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.put("/api/admin/hero-images/:id", isAuthenticated, upload.single("image"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const imageUrl = req.file ? `/uploads/${req.file.filename}` : undefined;

      // Only include the imageUrl in the update if a new one was uploaded
      const updateData = { ...req.body };
      if (imageUrl) {
        updateData.imageUrl = imageUrl;
      }

      // Parse boolean and number fields
      if (updateData.order !== undefined) {
        updateData.order = Number(updateData.order);
      }
      if (updateData.isActive !== undefined) {
        updateData.isActive = updateData.isActive === "true";
      }

      const result = await storage.updateHeroImage(id, updateData);

      if (!result) {
        return res.status(404).json({ message: "Hero image not found" });
      }

      res.json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  app.delete("/api/admin/hero-images/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteHeroImage(id);

      if (!success) {
        return res.status(404).json({ message: "Hero image not found" });
      }

      res.json({ message: "Hero image deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete hero image" });
    }
  });

  // Contact Requests
  app.get("/api/admin/contact-requests", isAuthenticated, async (req, res) => {
    try {
      const contactRequests = await storage.getContactRequests();
      res.json(contactRequests);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch contact requests" });
    }
  });

  app.put("/api/admin/contact-requests/:id/status", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body;

      if (!status || !["new", "processing", "completed", "archived"].includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      const result = await storage.updateContactRequestStatus(id, status);

      if (!result) {
        return res.status(404).json({ message: "Contact request not found" });
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to update contact request status" });
    }
  });

  app.delete("/api/admin/contact-requests/:id", isAuthenticated, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteContactRequest(id);

      if (!success) {
        return res.status(404).json({ message: "Contact request not found" });
      }

      res.json({ message: "Contact request deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete contact request" });
    }
  });

  // Settings
  app.get("/api/admin/settings", isAuthenticated, async (req, res) => {
    try {
      const settings = await storage.getAllSettings();
      res.json(settings);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  app.post("/api/admin/settings", isAuthenticated, async (req, res) => {
    try {
      const settingData = insertSettingSchema.parse(req.body);
      const result = await storage.upsertSetting(settingData);
      res.status(201).json(result);
    } catch (error) {
      handleZodError(error, res);
    }
  });

  // Logo upload
  app.post("/api/admin/settings/logo", isAuthenticated, upload.single("logo"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Logo file is required" });
      }

      // Use the correct path for the logo URL
      const logoUrl = `/uploads/${req.file.filename}`;
      
      // Save logo URL to settings with key "company_logo"
      const result = await storage.upsertSetting({
        key: "company_logo",
        value: logoUrl
      });
      
      // Invalidate any cached settings
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.status(201).json({ 
        message: "Logo uploaded successfully",
        logoUrl,
        setting: result
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to upload logo" });
    }
  });

  // User management (super_admin only)
  app.get("/api/admin/users", isSuperAdmin, async (req, res) => {
    try {
      // Get all users (this is for super_admin only)
      const allUsers = Array.from((await storage as any).users.values()).map((user: any) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt
      }));

      res.json(allUsers);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}