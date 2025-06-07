#!/usr/bin/env python3
"""
PDF to Markdown Converter

This script converts PDF files to markdown format, preserving basic formatting
like headers, paragraphs, and lists where possible.

Usage:
    python pdf_to_markdown.py <input_pdf_path> [output_md_path]

If output_md_path is not provided, it will create a .md file with the same name
as the input PDF in the same directory.
"""

import sys
import os
import re
import fitz  # PyMuPDF
from pathlib import Path


def extract_text_with_formatting(pdf_path):
    """
    Extract text from PDF while attempting to preserve formatting structure.
    
    Args:
        pdf_path (str): Path to the PDF file
        
    Returns:
        str: Extracted text with markdown formatting
    """
    try:
        doc = fitz.open(pdf_path)
        markdown_content = []
        
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            
            # Get text blocks with formatting information
            blocks = page.get_text("dict")
            
            # Add page separator for multi-page documents
            if page_num > 0:
                markdown_content.append(f"\n---\n# Page {page_num + 1}\n")
            
            for block in blocks["blocks"]:
                if "lines" in block:
                    block_text = []
                    
                    for line in block["lines"]:
                        line_text = ""
                        for span in line["spans"]:
                            text = span["text"].strip()
                            if text:
                                # Check for potential headers based on font size
                                font_size = span["size"]
                                flags = span["flags"]
                                
                                # Bold text (flags & 2^4 = 16)
                                is_bold = flags & 16
                                # Italic text (flags & 2^1 = 2)
                                is_italic = flags & 2
                                
                                # Apply formatting
                                if is_bold and font_size > 14:
                                    # Likely a main header
                                    text = f"## {text}"
                                elif is_bold and font_size > 12:
                                    # Likely a sub-header
                                    text = f"### {text}"
                                elif is_bold:
                                    # Bold text
                                    text = f"**{text}**"
                                elif is_italic:
                                    # Italic text
                                    text = f"*{text}*"
                                
                                line_text += text + " "
                        
                        if line_text.strip():
                            block_text.append(line_text.strip())
                    
                    if block_text:
                        # Join lines in the block
                        block_content = " ".join(block_text)
                        
                        # Clean up extra spaces
                        block_content = re.sub(r'\s+', ' ', block_content)
                        
                        # Add the block to markdown content
                        markdown_content.append(block_content)
        
        doc.close()
        
        # Join all content and clean up
        full_text = "\n\n".join(markdown_content)
        
        # Clean up common PDF artifacts
        full_text = clean_pdf_artifacts(full_text)
        
        return full_text
        
    except Exception as e:
        print(f"Error extracting text from PDF: {e}")
        return None


def clean_pdf_artifacts(text):
    """
    Clean common PDF extraction artifacts and improve markdown formatting.
    
    Args:
        text (str): Raw extracted text
        
    Returns:
        str: Cleaned text
    """
    # Remove excessive whitespace
    text = re.sub(r'\n\s*\n\s*\n', '\n\n', text)
    
    # Fix broken words (common in PDFs)
    text = re.sub(r'(\w+)-\s*\n\s*(\w+)', r'\1\2', text)
    
    # Improve list formatting
    text = re.sub(r'^([•·▪▫▸▹‣⁃]|\d+\.)\s*', r'- ', text, flags=re.MULTILINE)
    
    # Clean up headers that might have been over-formatted
    text = re.sub(r'#{4,}', '###', text)
    
    # Remove standalone page numbers
    text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
    
    # Clean up URLs
    text = re.sub(r'(https?://[^\s]+)', r'<\1>', text)
    
    return text.strip()


def pdf_to_markdown(pdf_path, output_path=None):
    """
    Convert PDF to markdown file.
    
    Args:
        pdf_path (str): Path to input PDF file
        output_path (str, optional): Path for output markdown file
    """
    if not os.path.exists(pdf_path):
        print(f"Error: PDF file '{pdf_path}' not found.")
        return False
    
    # Generate output path if not provided
    if output_path is None:
        pdf_file = Path(pdf_path)
        output_path = pdf_file.with_suffix('.md')
    
    print(f"Converting '{pdf_path}' to markdown...")
    
    # Extract text with formatting
    markdown_text = extract_text_with_formatting(pdf_path)
    
    if markdown_text is None:
        print("Failed to extract text from PDF.")
        return False
    
    # Add document header
    pdf_name = Path(pdf_path).stem
    header = f"# {pdf_name.replace('_', ' ').title()}\n\n"
    header += f"*Converted from PDF: {Path(pdf_path).name}*\n\n---\n\n"
    
    final_content = header + markdown_text
    
    # Write to markdown file
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(final_content)
        
        print(f"Successfully converted to markdown: '{output_path}'")
        print(f"Document length: {len(markdown_text)} characters")
        return True
        
    except Exception as e:
        print(f"Error writing markdown file: {e}")
        return False


def main():
    """Main function to handle command line arguments."""
    if len(sys.argv) < 2:
        print("Usage: python pdf_to_markdown.py <input_pdf_path> [output_md_path]")
        print("\nExample:")
        print("  python pdf_to_markdown.py document.pdf")
        print("  python pdf_to_markdown.py document.pdf output.md")
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    
    # Convert relative paths to absolute paths
    if not os.path.isabs(pdf_path):
        # Look for PDF in parent directory (where the Garmin PDF is located)
        parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pdf_path = os.path.join(parent_dir, pdf_path)
    
    success = pdf_to_markdown(pdf_path, output_path)
    
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main() 