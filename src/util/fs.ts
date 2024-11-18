import * as fs from 'fs';
import * as path from 'path';

export function isFolderExists(folderPath: string): boolean {
  try {
    // Check if the path exists
    fs.accessSync(folderPath, fs.constants.F_OK);

    // Check if it's a directory
    const stats = fs.statSync(folderPath);
    return stats.isDirectory();
  } catch (error) {
    // If the access or stat fails, or if it's not a directory, return false
    return false;
  }
}

export function copyFolderSync(source: string, destination: string) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const files = fs.readdirSync(source);

  for (const file of files) {
    const currentPath = path.join(source, file);
    const destinationPath = path.join(destination, file);

    if (fs.statSync(currentPath).isDirectory()) {
      copyFolderSync(currentPath, destinationPath);
    } else {
      fs.copyFileSync(currentPath, destinationPath);
    }
  }
}

export function copyFileSync(source: string, target: string) {
  let targetFile = target;

  // If target is a directory, a new file with the same name will be created
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isDirectory()) {
      targetFile = path.join(target, path.basename(source));
    }
  }

  fs.writeFileSync(targetFile, fs.readFileSync(source));
}

export async function copyFilesWithExclusion(sourceDir: string, destinationDir: string, excludedFolders: string[]) {
  try {
    // Ensure the destination directory exists
    await fs.promises.mkdir(destinationDir, { recursive: true });

    // Start copying recursively from the source directory
    await copyRecursive(sourceDir, destinationDir, excludedFolders);
  } catch (error) {
    console.error('An error occurred during copying files:', error);
  }
}

// Function to recursively copy files and directories
export async function copyRecursive(source: string, destination: string, excludedFolders: string[]) {
  // Get a list of all files and directories in the source directory
  const files = await fs.promises.readdir(source);

  // Iterate through each file or directory
  for (const file of files) {
    const sourcePath = path.join(source, file);
    const destPath = path.join(destination, file);

    // Get the file's stats
    const stats = await fs.promises.stat(sourcePath);

    // If it's a directory, recursively copy it (unless it's excluded)
    if (stats.isDirectory()) {
      if (excludedFolders.includes(file)) {
        // Skipping directory: ${sourcePath}
      } else {
        // Ensure destination directory exists before copying
        await fs.promises.mkdir(destPath, { recursive: true });
        await copyRecursive(sourcePath, destPath, excludedFolders);
      }
    } else {
      // Otherwise, copy the file
      await fs.promises.copyFile(sourcePath, destPath);
    }
  }
}

export async function readFileToUint8Array(filePath: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(new Uint8Array(data));
    });
  });
}

export function getBinaryFilesFromPath(fileOrFolderPath: string): string[] {
  if (!fs.existsSync(fileOrFolderPath)) {
    throw new Error(`File or Folder not exits ${fileOrFolderPath}`);
  }
  // Check if the provided path is a directory
  if (fs.lstatSync(fileOrFolderPath).isDirectory()) {
    return listBinaryFilesInFolder(fileOrFolderPath);
  }

  if (fs.lstatSync(fileOrFolderPath).isFile() && isBinaryFile(fileOrFolderPath)) {
    return [fileOrFolderPath];
  }

  throw new Error(`${fileOrFolderPath} is not a valid path to deploy scripts.`);
}

export function listBinaryFilesInFolder(folderPath: string): string[] {
  // Check if the provided path is a directory
  if (!fs.existsSync(folderPath) || !fs.lstatSync(folderPath).isDirectory()) {
    throw new Error(`${folderPath} is not a valid directory.`);
  }

  // Read the contents of the directory
  const files = fs.readdirSync(folderPath).map((f) => path.join(folderPath, f));

  // Filter out only the binary files (assuming they have extensions like .exe, .bin, .dll, etc.)
  const binaryFiles = files.filter((file) => fs.statSync(file).isFile() && isBinaryFile(file));
  return binaryFiles;
}

// Function to check if a file is binary
export function isBinaryFile(filePath: string): boolean {
  const buffer = fs.readFileSync(filePath);
  for (let i = 0; i < buffer.length; i++) {
    // If any byte has a value greater than 127, it's likely a binary file
    if (buffer[i] > 127) {
      return true;
    }
  }
  return false;
}

export function isAbsolutePath(filePath: string): boolean {
  return path.isAbsolute(filePath);
}

export function findFileInFolder(folderPath: string, fileName: string): string | null {
  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      const foundFilePath = findFileInFolder(filePath, fileName);
      if (foundFilePath) {
        return foundFilePath;
      }
    } else if (file === fileName) {
      return filePath;
    }
  }

  return null;
}

export function getSubfolders(folderPath: string): string[] {
  return fs.readdirSync(folderPath).filter((file) => {
    const fullPath = path.join(folderPath, file);
    return fs.statSync(fullPath).isDirectory();
  });
}
